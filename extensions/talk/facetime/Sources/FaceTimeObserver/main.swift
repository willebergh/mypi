import AppKit
import ApplicationServices
import Foundation

struct Options {
    var command = "help"
    var filter = TargetFilter()
    var keywords: [String] = []
    var maxDepth = 12
    var maxNodes = 2_000
    var interval = 2.0
    var prompt = false
    var socketPath = "~/.local/share/pi-facetime/control.sock"
    var snapshotDirectory: String?
    var configPath: String
    var configError: String?
    var allowedCallers: [String] = []
    var allowedRecipients: [String] = []
    var recipientAliases: [String: [String]] = [:]
    var autoAnswer = false
    var inputDevice: String?
    var outputDevice: String?
    var callStartTimeoutSeconds = 15.0
    var ringingTimeoutSeconds = 60.0
    var verbose = false
    private var autoAnswerOverride = false

    mutating func applyConfiguration(_ config: DaemonConfiguration) {
        allowedCallers = config.allowedCallers
        allowedRecipients = config.allowedRecipients
        recipientAliases = config.recipientAliases
        autoAnswer = config.autoAnswer || autoAnswerOverride
        inputDevice = config.inputDevice
        outputDevice = config.outputDevice
        callStartTimeoutSeconds = config.callStartTimeoutSeconds
        ringingTimeoutSeconds = config.ringingTimeoutSeconds
        configError = nil
    }

    var configurationJSON: [String: Any] {
        [
            "configPath": configPath,
            "inputDevice": inputDevice ?? NSNull(),
            "outputDevice": outputDevice ?? NSNull(),
            "autoAnswer": autoAnswer,
            "allowedCallerCount": allowedCallers.count,
            "allowedRecipientCount": allowedRecipients.count
        ]
    }

    init(arguments: [String], persistedConfigPath: String? = nil,
         environment: [String: String] = ProcessInfo.processInfo.environment,
         homeDirectory: String = NSHomeDirectory(),
         currentDirectory: String = FileManager.default.currentDirectoryPath) {
        var args = Array(arguments.dropFirst())
        var explicitPath: String?
        if let configIndex = args.firstIndex(of: "--config"), configIndex + 1 < args.count {
            explicitPath = args[configIndex + 1]
        }
        configPath = resolveTalkConfigPath(explicitPath: explicitPath, persistedPath: persistedConfigPath,
                                          environment: environment, homeDirectory: homeDirectory,
                                          currentDirectory: currentDirectory)
        do {
            applyConfiguration(try DaemonConfiguration.load(path: configPath))
        } catch {
            configError = error.localizedDescription
        }
        if let first = args.first, !first.hasPrefix("-") {
            command = first
            args.removeFirst()
        }
        var index = 0
        while index < args.count {
            let arg = args[index]
            func next() -> String? {
                guard index + 1 < args.count else { return nil }
                index += 1
                return args[index]
            }
            switch arg {
            case "--pid": if let value = next(), let pid = pid_t(value) { filter.pids.insert(pid) }
            case "--bundle": if let value = next() { filter.bundleIDs.append(value) }
            case "--process": if let value = next() { filter.processTerms.append(value) }
            case "--keyword": if let value = next() { keywords.append(value) }
            case "--max-depth": if let value = next(), let parsed = Int(value) { maxDepth = parsed }
            case "--max-nodes": if let value = next(), let parsed = Int(value) { maxNodes = parsed }
            case "--interval": if let value = next(), let parsed = Double(value) { interval = parsed }
            case "--socket": if let value = next() { socketPath = value }
            case "--snapshot-dir": snapshotDirectory = next()
            case "--config": _ = next()
            case "--allow-caller": if let value = next() { allowedCallers.append(value) }
            case "--allow-recipient": if let value = next() { allowedRecipients.append(value) }
            case "--input-device": inputDevice = next()
            case "--output-device": outputDevice = next()
            case "--call-start-timeout": if let value = next(), let parsed = Double(value) { callStartTimeoutSeconds = parsed }
            case "--ringing-timeout": if let value = next(), let parsed = Double(value) { ringingTimeoutSeconds = parsed }
            case "--auto-answer": autoAnswerOverride = true; autoAnswer = true
            case "--verbose": verbose = true
            case "--prompt": prompt = true
            case "--help", "-h": command = "help"
            default:
                fputs("Unknown argument: \(arg)\n", stderr)
                command = "help"
            }
            index += 1
        }
    }
}

final class WatchService: @unchecked Sendable {
    private(set) var options: Options
    let reader: AXTreeReader
    private var observers: [pid_t: AXProcessObserver] = [:]
    private var snapshots: [pid_t: [String: Any]] = [:]
    private var fingerprints: [pid_t: Data] = [:]
    private var metadata = ServiceMetadata()
    private var timer: Timer?
    private var socket: SocketServer?
    private var run: ServiceRun?
    private let emitStdout: Bool
    var isRunning: Bool { run?.isRunning == true }
    private var callTracker = CallStateTracker()
    private var screenSharing: ScreenSharingController?
    private var videoLayout: VideoLayoutController?
    private var videoLayoutObserver = VideoLayoutObserver()
    private var videoFollow: VideoFollowController?
    private var autoAnswerAttemptedCallID: String?
    private var confirmationAttemptedCallID: String?
    private var routedFaceTimePID: pid_t?
    private var pendingRecipient: String?
    private var outgoingLaunchPending = false
    private var callStartDeadline: Date?
    private var ringingDeadline: Date?

    init(options: Options, emitStdout: Bool = true) {
        self.options = options
        self.emitStdout = emitStdout
        reader = AXTreeReader(maxDepth: options.maxDepth, maxNodes: options.maxNodes)
    }

    // Service state and AX work are confined to the main thread. Socket ingress
    // captures a per-start token before hopping to main, not mutable run state.
    func start() throws {
        guard !isRunning else { return }
        let run = ServiceRun()
        self.run = run
        screenSharing = ScreenSharingController(ax: ControlCenterScreenSharingAX(), currentCall: { [weak self] in
            guard let self else { return ScreenSharingCall(id: nil, phase: "idle", verified: false, identity: nil, present: false) }
            // Read only the current call banner. Full reconcile() can answer,
            // route, or enforce timeouts and must not be used as a UI guard.
            let targets = self.controlTargets().filter { $0.bundleIdentifier == "com.apple.notificationcenterui" }
            let freshReader = AXTreeReader(maxDepth: 12, maxNodes: 2_000)
            let fresh = CallObservation.extract(from: targets.map { freshReader.tree(for: $0, keywords: []) })
            return screenSharingCall(tracker: self.callTracker, fresh: fresh)
        }, isRunning: { run.isRunning })
        videoLayout = VideoLayoutController(isRunning: { run.isRunning })
        let followStore = VideoFollowStore(configPath: options.configPath)
        let followSettings: VideoFollowSettings
        let followError: String?
        do { followSettings = try followStore.load(); followError = nil }
        catch { followSettings = VideoFollowSettings(); followError = "Invalid video follow preferences; automatic rotation is disabled" }
        videoFollow = VideoFollowController(settings: followSettings, loadError: followError,
            save: { try followStore.save($0) },
            allowed: { [weak self] peer in
                self.map { callerIsAllowed(peer, allowedCallers: $0.options.allowedCallers) } ?? false
            }, rotate: { [weak self] action, complete in
                guard let self, run.isRunning, let controller = self.videoLayout else { return }
                controller.rotate(action.command, authorize: { [weak self] layout, afterAttempt in
                    run.isRunning && (self?.videoFollow?.permits(layout, action: action, afterAttempt: afterAttempt) ?? false)
                }, completion: complete)
            }, emit: { [weak self] event in run.perform { self?.emit(event) } })
        let configuration = options.configurationJSON
        let socket = SocketServer(path: options.socketPath, initial: { [weak self] in
            guard run.isRunning, let self else {
                return ["type": "snapshot", "protocolVersion": 1, "configuration": configuration]
            }
            return self.initialState()
        }, command: { [weak self] command, reply in
            DispatchQueue.main.async {
                run.perform { self?.handle(command, reply: reply) }
            }
        })
        self.socket = socket
        do {
            try socket.start()
        } catch {
            stop()
            throw error
        }
        emit(["type": "event", "event": "bridge.status", "status": "started", "socket": NSString(string: options.socketPath).expandingTildeInPath])
        reconcile(emitChanges: false)
        timer = Timer.scheduledTimer(withTimeInterval: max(0.25, options.interval), repeats: true) { [weak self] _ in
            run.perform { self?.reconcile(emitChanges: true) }
        }
    }

    // Stop observation/control only: never press End, cancel a call, or tell Pi
    // to abort. Invalidate callbacks before closing sockets or removing sources.
    func stop() {
        run?.stop()
        run = nil
        screenSharing?.invalidate()
        screenSharing = nil
        videoFollow?.invalidate()
        videoFollow = nil
        videoLayout?.invalidate()
        videoLayout = nil
        videoLayoutObserver = VideoLayoutObserver()
        timer?.invalidate()
        timer = nil
        for observer in observers.values { observer.stop() }
        observers.removeAll()
        socket?.stop()
        socket = nil
        snapshots.removeAll()
        fingerprints.removeAll()
        clearOutgoingRequest()
        autoAnswerAttemptedCallID = nil
        routedFaceTimePID = nil
        callTracker = CallStateTracker()
        metadata = ServiceMetadata()
    }

    deinit { stop() }

    private func reconcile(emitChanges: Bool) {
        guard isRunning else { return }
        let targets = runningTargets(filter: options.filter)
        let currentPIDs = Set(targets.map(\.pid))
        for pid in Set(observers.keys).subtracting(currentPIDs) {
            observers.removeValue(forKey: pid)?.stop()
            snapshots.removeValue(forKey: pid)
            fingerprints.removeValue(forKey: pid)
            emit(["type": "event", "event": "process.stopped", "pid": Int(pid)])
        }
        for target in targets where observers[target.pid] == nil {
            let currentRun = run
            let observer = AXProcessObserver(target: target, reader: reader) { [weak self] event in
                currentRun?.perform { self?.emit(event) }
            }
            if let error = observer.start() {
                emit(["type": "diagnostic", "level": "warning", "message": "Could not observe process", "process": target.json, "error": error])
            } else {
                observers[target.pid] = observer
                emit(["type": "event", "event": "process.started", "process": target.json])
            }
        }

        for target in targets {
            observers[target.pid]?.registerCurrentTree()
            let snapshot = reader.tree(for: target, keywords: [])
            let fingerprint = try? jsonData(snapshot)
            let changed = fingerprints[target.pid] != fingerprint
            snapshots[target.pid] = snapshot
            fingerprints[target.pid] = fingerprint
            if emitChanges && changed {
                emit(["type": "event", "event": "accessibility.reconciled", "process": target.json, "nodeCount": snapshot["nodeCount"] ?? 0])
            }
        }

        let currentSnapshots = Array(snapshots.values)
        let currentVideo = VideoLayout.extract(currentSnapshots)
        if let event = videoLayoutObserver.update(currentVideo) { emit(event) }
        videoFollow?.observe(currentVideo, manualBusy: videoLayout?.isBusy ?? false)
        handleCallConfirmation(CallConfirmation.extract(from: currentSnapshots))
        let observation = CallObservation.extract(from: currentSnapshots)
        if pendingRecipient != nil, observation.present, let observedIdentity = observation.identity,
           !isObservedRecipientAllowed(observedIdentity) {
            _ = performSemanticPress(label: "End", targets: controlTargets())
            if let event = callTracker.forceFailed(evidence: "observed_recipient_not_allowlisted") { emit(event) }
            clearOutgoingRequest()
        } else {
            let callEvents = callTracker.update(observation)
            for event in callEvents {
                emit(event)
                switch event["event"] as? String {
                case "call.dialing":
                    ringingDeadline = Date().addingTimeInterval(max(1, options.ringingTimeoutSeconds))
                case "call.connected":
                    callStartDeadline = nil
                    ringingDeadline = nil
                case "call.failed", "call.ended":
                    clearOutgoingRequest()
                default: break
                }
            }
            if !callEvents.isEmpty { saveAllSnapshotsIfRequested() }
        }
        // Only the already-loaded options are used; no file watching. Defer
        // startup routing until FaceTime exists and the tracked call is idle.
        applyConfiguredAudioRoutingIfNeeded(targets: controlTargets())
        enforceCallTimeouts(targets: targets)
        maybeAutoAnswer()
    }

    private func initialState(includeTrees: Bool = false) -> [String: Any] {
        let processes: Any = includeTrees ? Array(snapshots.values) : snapshots.values.map { snapshot in
            ["process": snapshot["process"] ?? [:], "nodeCount": snapshot["nodeCount"] ?? 0]
        }
        return metadata.snapshot([
            "type": "snapshot",
            "protocolVersion": 1,
            "timestamp": timestamp(),
            "permission": permissionDiagnostic(),
            "call": callTracker.statusJSON,
            "video": VideoLayout.extract(Array(snapshots.values))?.json ?? ["available": false],
            "videoFollow": videoFollow?.status ?? ["enabled": false],
            "configuration": options.configurationJSON,
            "processes": processes
        ], allowedCallers: options.allowedCallers)
    }

    private func handle(_ command: [String: Any], reply rawReply: @escaping ([String: Any]) -> Void) {
        guard let run, run.isRunning else { return }
        let reply: ([String: Any]) -> Void = { [weak self] response in
            guard run.isRunning, let self else { return }
            rawReply(self.metadata.envelope(response))
        }
        let id = command["id"] ?? NSNull()
        guard command["type"] as? String == "command", let name = command["command"] as? String else {
            reply(["type": "response", "id": id, "ok": false, "error": ["code": "invalid_command", "message": "Expected type=command and a command string"]])
            return
        }
        switch name {
        case "status":
            reply(["type": "response", "id": id, "ok": true, "result": initialState()])
        case "config.reload":
            do {
                try validateConfigReloadCommand(command)
                let candidate = try reloadedTalkOptions(current: options, phase: callTracker.phase,
                    hasPendingOutgoing: pendingRecipient != nil || outgoingLaunchPending,
                    hasTrackedCall: callTracker.callID != nil,
                    applyRouting: { input, output in
                        let result = selectFaceTimeAudioDevices(input: input, output: output, targets: self.controlTargets())
                        guard result.ok else {
                            throw ConfigurationReloadError(code: "audio_routing_failed", message: result.error ?? "Audio routing failed")
                        }
                    })
                // Commit policy and routes together only after successful
                // validation and verified audio routing. Never reconcile here:
                // reload cannot answer, initiate, confirm, or end a call.
                options = candidate
                routedFaceTimePID = controlTargets().first(where: { $0.bundleIdentifier == "com.apple.FaceTime" })?.pid
                reply(["type": "response", "id": id, "ok": true, "result": initialState()])
            } catch let error as ConfigurationReloadError {
                reply(commandError(id: id, code: error.code, message: error.localizedDescription))
            } catch {
                reply(commandError(id: id, code: "config_reload_failed", message: error.localizedDescription))
            }
        case "inspect":
            reconcile(emitChanges: false)
            reply(["type": "response", "id": id, "ok": true, "result": initialState(includeTrees: true)])
        case "answer":
            guard callTracker.phase == "incoming", let identity = callTracker.observation.identity else {
                reply(commandError(id: id, code: "no_incoming_call", message: "No identifiable incoming call is present"))
                return
            }
            guard isAllowed(identity) else {
                reply(commandError(id: id, code: "caller_not_allowed", message: "Caller is not in the Swift allowlist"))
                return
            }
            let result = performIncomingAnswer(expectedIdentity: identity, targets: controlTargets())
            emit([
                "type": "event",
                "event": "call.answer_attempted",
                "callId": callTracker.callID ?? NSNull(),
                "identity": identity,
                "verified": result.ok,
                "error": result.error ?? NSNull()
            ])
            reply(actionResponse(id: id, action: result))
        case "hangup":
            guard callTracker.phase != "idle" else {
                reply(commandError(id: id, code: "no_active_call", message: "No call is active"))
                return
            }
            let result = performSemanticPress(label: "End", targets: controlTargets())
            if result.ok { callTracker.markLocalHangupRequested() }
            reply(actionResponse(id: id, action: result))
        case "call":
            guard callTracker.phase == "idle", callTracker.callID == nil, pendingRecipient == nil, !outgoingLaunchPending else {
                reply(commandError(id: id, code: "call_in_progress", message: "A call or call request is already active"))
                return
            }
            guard let recipient = command["to"] as? String, isRecipientAllowed(recipient) else {
                reply(commandError(id: id, code: "recipient_not_allowed", message: "Recipient must exactly match the Swift recipient allowlist"))
                return
            }
            startOutgoingCall(recipient: recipient, id: id, reply: reply)
        case "video.follow.status", "video.follow.set", "video.follow.calibrate":
            do {
                guard let follow = videoFollow else { throw videoFollowError("Video follow controller is unavailable") }
                let extra: Set<String> = name == "video.follow.set" ? ["enabled"] :
                    name == "video.follow.calibrate" ? ["orientation", "expectedWindowId", "expectedPeer", "expectedLocalAxis"] : []
                guard Set(command.keys).isSubset(of: extra.union(["type", "command", "id"])) else {
                    throw videoFollowError("Unknown video follow command argument")
                }
                var value: [String: Any]
                if name == "video.follow.set" {
                    guard let enabled = command["enabled"] as? NSNumber,
                          CFGetTypeID(enabled) == CFBooleanGetTypeID() else { throw videoFollowError("enabled must be a boolean") }
                    try follow.setEnabled(enabled.boolValue)
                    value = follow.status
                } else if name == "video.follow.calibrate" {
                    guard let orientation = command["orientation"] as? String,
                          let windowID = command["expectedWindowId"] as? String,
                          let peer = command["expectedPeer"] as? String,
                          let layout = try videoLayout?.readCurrent() else { throw videoFollowError("Calibration requires current video.status target values") }
                    let axis = command["expectedLocalAxis"] as? String
                    guard command["expectedLocalAxis"] == nil || axis.map({ ["portrait", "landscape"].contains($0) }) == true else {
                        throw videoFollowError("expectedLocalAxis must be portrait or landscape")
                    }
                    value = try follow.calibrate(orientation: orientation, layout: layout, expectedWindowID: windowID, expectedPeer: peer, expectedLocalAxis: axis)
                } else { value = follow.status }
                reply(["type": "response", "id": id, "ok": true, "result": value])
            } catch {
                let error = (error as? VideoLayoutError) ?? videoFollowError("Could not save video follow preferences")
                reply(commandError(id: id, code: error.code, message: error.message))
            }
        case "video.status":
            guard Set(command.keys).isSubset(of: ["type", "command", "id"]) else {
                reply(commandError(id: id, code: "invalid_command", message: "video.status accepts no parameters"))
                return
            }
            reply(["type": "response", "id": id, "ok": true, "result": videoLayout?.status() ?? ["available": false]])
        case "video.rotate":
            videoLayout?.rotate(command) { result in
                switch result {
                case .success(let value): reply(["type": "response", "id": id, "ok": true, "result": value])
                case .failure(let error): reply(self.commandError(id: id, code: error.code, message: error.message))
                }
            }
        case "screen.share", "screen.stop", "screen.status":
            do {
                let request = try ScreenSharingCommand(command)
                screenSharing?.execute(request) { result in
                    switch result {
                    case .success(let value):
                        reply(["type": "response", "id": id, "ok": true, "result": value])
                    case .failure(let error):
                        reply(["type": "response", "id": id, "ok": false,
                               "error": ["code": error.code, "message": error.message]])
                    }
                }
            } catch let error as ScreenSharingError {
                reply(commandError(id: id, code: error.code, message: error.message))
            } catch {
                reply(commandError(id: id, code: "invalid_command", message: error.localizedDescription))
            }
        case "audio.devices":
            let result = listFaceTimeAudioDevices(targets: controlTargets())
            reply(audioResponse(id: id, result: result))
        case "audio.select":
            let input = command["input"] as? String
            let output = command["output"] as? String
            let result = selectFaceTimeAudioDevices(input: input, output: output, targets: controlTargets())
            reply(audioResponse(id: id, result: result))
        case "snapshot":
            let paths = writeAllSnapshots()
            reply(["type": "response", "id": id, "ok": true, "result": ["paths": paths]])
        case "discover":
            reply(["type": "response", "id": id, "ok": true, "result": ["processes": allInterestingProcesses()]])
        default:
            reply(["type": "response", "id": id, "ok": false, "error": ["code": "unsupported_command", "message": "Supported commands: status, config.reload, inspect, snapshot, discover, call, answer, hangup, audio.devices, audio.select, screen.share, screen.stop, screen.status, video.status, video.rotate, video.follow.status, video.follow.set, video.follow.calibrate"]])
        }
    }

    private func commandError(id: Any, code: String, message: String) -> [String: Any] {
        ["type": "response", "id": id, "ok": false, "error": ["code": code, "message": message]]
    }

    private func actionResponse(id: Any, action: AXActionResult) -> [String: Any] {
        if action.ok { return ["type": "response", "id": id, "ok": true, "result": action.element ?? [:]] }
        return commandError(id: id, code: "ax_action_failed", message: action.error ?? "Accessibility action failed")
    }

    private func audioResponse(id: Any, result: FaceTimeAudioRoutingResult) -> [String: Any] {
        if result.ok {
            return ["type": "response", "id": id, "ok": true, "result": ["devices": result.devices.map(\.json)]]
        }
        return commandError(id: id, code: "audio_routing_failed", message: result.error ?? "Audio routing failed")
    }

    private func isAllowed(_ identity: String) -> Bool {
        callerIsAllowed(identity, allowedCallers: options.allowedCallers)
    }

    private func isRecipientAllowed(_ identity: String) -> Bool {
        let wanted = normalizedIdentity(identity)
        return options.allowedRecipients.map(normalizedIdentity).contains(wanted)
    }

    private func isObservedRecipientAllowed(_ identity: String) -> Bool {
        guard let pendingRecipient else { return isRecipientAllowed(identity) }
        let observed = normalizedIdentity(identity)
        if observed == normalizedIdentity(pendingRecipient) { return true }
        let aliases = options.recipientAliases.first(where: { normalizedIdentity($0.key) == normalizedIdentity(pendingRecipient) })?.value ?? []
        return aliases.map(normalizedIdentity).contains(observed)
    }

    private func handleCallConfirmation(_ confirmation: CallConfirmation?) {
        guard isRunning, let confirmation,
              let callID = callTracker.callID,
              pendingRecipient != nil,
              confirmationAttemptedCallID != callID else { return }
        guard isObservedRecipientAllowed(confirmation.identity) else {
            if let event = callTracker.forceFailed(evidence: "click_to_call_identity_not_allowlisted") { emit(event) }
            clearOutgoingRequest()
            return
        }
        confirmationAttemptedCallID = callID
        let result = performCallConfirmation(expectedIdentity: confirmation.identity, targets: controlTargets())
        emit([
            "type": "event",
            "event": "call.confirmation_attempted",
            "callId": callID,
            "identity": confirmation.identity,
            "verified": result.ok,
            "error": result.error ?? NSNull()
        ])
        if result.ok {
            callStartDeadline = Date().addingTimeInterval(max(1, options.callStartTimeoutSeconds))
        }
    }

    private func controlTargets() -> [ProcessTarget] {
        runningTargets(filter: TargetFilter())
    }

    private func applyConfiguredAudioRouting(targets: [ProcessTarget]) -> String? {
        guard options.inputDevice != nil, options.outputDevice != nil else { return nil }
        let result = selectFaceTimeAudioDevices(input: options.inputDevice, output: options.outputDevice, targets: targets)
        return result.ok ? nil : (result.error ?? "Audio routing failed")
    }

    private func applyConfiguredAudioRoutingIfNeeded(targets: [ProcessTarget]) {
        guard callTracker.phase == "idle", callTracker.callID == nil, pendingRecipient == nil, !outgoingLaunchPending,
              options.inputDevice != nil, options.outputDevice != nil,
              let faceTime = targets.first(where: { $0.bundleIdentifier == "com.apple.FaceTime" }),
              routedFaceTimePID != faceTime.pid else { return }
        if let error = applyConfiguredAudioRouting(targets: targets) {
            emit(["type": "event", "event": "audio.routing", "ok": false, "error": error])
        } else {
            routedFaceTimePID = faceTime.pid
            emit(["type": "event", "event": "audio.routing", "ok": true, "input": options.inputDevice ?? NSNull(), "output": options.outputDevice ?? NSNull()])
        }
    }

    private func startOutgoingCall(recipient: String, id: Any, reply: @escaping ([String: Any]) -> Void) {
        guard let run, run.isRunning else { return }
        outgoingLaunchPending = true
        let proceed = { [weak self] in
            guard run.isRunning, let self else { return }
            // FaceTime launch is asynchronous; an incoming/unknown call may
            // have appeared since the original request was accepted.
            guard self.callTracker.phase == "idle", self.callTracker.callID == nil else {
                self.outgoingLaunchPending = false
                reply(self.commandError(id: id, code: "call_in_progress", message: "A call is already active"))
                return
            }
            let targets = self.controlTargets()
            if let routingError = self.applyConfiguredAudioRouting(targets: targets) {
                self.outgoingLaunchPending = false
                reply(self.commandError(id: id, code: "audio_routing_failed", message: routingError))
                return
            }
            guard let callID = self.callTracker.beginOutgoingRequest(identity: recipient) else {
                self.outgoingLaunchPending = false
                reply(self.commandError(id: id, code: "call_in_progress", message: "A call is already active"))
                return
            }
            self.outgoingLaunchPending = false
            self.pendingRecipient = recipient
            self.callStartDeadline = Date().addingTimeInterval(max(1, self.options.callStartTimeoutSeconds))
            initiateFaceTimeAudioCall(to: recipient) { [weak self] result in
                DispatchQueue.main.async { [weak self] in
                    guard run.isRunning, let self else { return }
                    switch result {
                    case .success:
                        reply(["type": "response", "id": id, "ok": true, "result": ["callId": callID, "to": recipient]])
                    case .failure(let error):
                        if let event = self.callTracker.forceFailed(evidence: "launch_failed") { self.emit(event) }
                        self.clearOutgoingRequest()
                        reply(self.commandError(id: id, code: "call_launch_failed", message: error.localizedDescription))
                    }
                }
            }
        }

        if controlTargets().contains(where: { $0.bundleIdentifier == "com.apple.FaceTime" }) {
            proceed()
        } else {
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = false
            NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: "/System/Applications/FaceTime.app"), configuration: configuration) { [weak self] _, error in
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
                    guard run.isRunning, let self else { return }
                    if let error {
                        self.outgoingLaunchPending = false
                        reply(self.commandError(id: id, code: "facetime_launch_failed", message: error.localizedDescription))
                    } else { proceed() }
                }
            }
        }
    }

    private func enforceCallTimeouts(targets: [ProcessTarget]) {
        guard isRunning else { return }
        let now = Date()
        if let deadline = callStartDeadline, now >= deadline, callTracker.phase == "starting" {
            if let event = callTracker.forceFailed(evidence: "call_ui_not_observed_before_timeout") { emit(event) }
            clearOutgoingRequest()
        } else if let deadline = ringingDeadline, now >= deadline, callTracker.phase == "dialing" {
            _ = performSemanticPress(label: "End", targets: targets)
            if let event = callTracker.forceFailed(evidence: "no_answer_timeout") { emit(event) }
            clearOutgoingRequest()
        }
    }

    private func clearOutgoingRequest() {
        outgoingLaunchPending = false
        pendingRecipient = nil
        confirmationAttemptedCallID = nil
        callStartDeadline = nil
        ringingDeadline = nil
    }

    private func maybeAutoAnswer() {
        guard let run, run.isRunning, options.autoAnswer,
              callTracker.phase == "incoming",
              let callID = callTracker.callID,
              autoAnswerAttemptedCallID != callID,
              let identity = callTracker.observation.identity,
              isAllowed(identity) else { return }
        autoAnswerAttemptedCallID = callID
        // The banner is sometimes still animating when first observed. Reacquire
        // the exact allowlisted banner and its Answer button after a short delay.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
            guard run.isRunning, let self,
                  self.callTracker.callID == callID,
                  self.callTracker.phase == "incoming",
                  self.callTracker.observation.identity.map(self.isAllowed) == true else { return }
            let result = performIncomingAnswer(expectedIdentity: identity, targets: self.controlTargets())
            self.emit(["type": "event", "event": "call.answer_attempted", "callId": callID, "identity": identity, "verified": result.ok, "error": result.error ?? NSNull()])
        }
    }

    private func emit(_ raw: [String: Any]) {
        guard isRunning else { return }
        let event = metadata.event(raw, allowedCallers: options.allowedCallers)
        if emitStdout {
            print(jsonString(event))
            fflush(stdout)
        }
        socket?.broadcast(event)
    }

    private func saveAllSnapshotsIfRequested() {
        guard options.snapshotDirectory != nil else { return }
        _ = writeAllSnapshots()
    }

    private func writeAllSnapshots() -> [String] {
        let directory = options.snapshotDirectory ?? "./snapshots"
        return snapshots.compactMap { pid, snapshot in
            let target = observers[pid]?.target ?? ProcessTarget(pid: pid, name: "pid-\(pid)", bundleIdentifier: nil)
            return writeSnapshot(snapshot, target: target, directory: directory)
        }
    }

    private func writeSnapshot(_ snapshot: [String: Any], target: ProcessTarget, directory: String) -> String? {
        do {
            let expanded = NSString(string: directory).expandingTildeInPath
            try FileManager.default.createDirectory(atPath: expanded, withIntermediateDirectories: true)
            let stamp = timestamp().replacingOccurrences(of: ":", with: "-")
            let safeName = target.name.replacingOccurrences(of: "/", with: "-")
            let path = "\(expanded)/\(stamp)-\(safeName)-\(target.pid).json"
            try jsonData(snapshot, pretty: true).write(to: URL(fileURLWithPath: path), options: .atomic)
            return path
        } catch {
            emit(["type": "diagnostic", "level": "error", "message": "Snapshot write failed", "error": error.localizedDescription])
            return nil
        }
    }
}

func printUsage() {
    print("""
    facetime-observer — generic macOS Accessibility inspector

    USAGE
      facetime-observer permission [--prompt]
      facetime-observer discover
      facetime-observer dump [target options] [tree options]
      facetime-observer snapshot [target options] [tree options] [--snapshot-dir DIR]
      facetime-observer watch [target options] [tree options] [--socket PATH]
      facetime-observer monitor [--socket PATH] [--verbose]

    TARGET OPTIONS (may be repeated)
      --pid PID              Exact process ID
      --bundle TEXT          Bundle identifier substring
      --process TEXT         Process name or bundle substring
      With no target, FaceTime/Notification Center/call-related candidates are used.

    TREE/WATCH OPTIONS
      --keyword TEXT         Keep matching nodes and their ancestors
      --max-depth N          Tree traversal depth (default 12)
      --max-nodes N          Per-process node cap (default 2000)
      --interval SECONDS     Reconciliation interval (default 2)
      --snapshot-dir DIR     Save snapshots at semantic call transitions
      --socket PATH          Default: ~/.local/share/pi-facetime/control.sock
      --config PATH          Default: $PI_CODING_AGENT_DIR/talk.json or ~/.pi/agent/talk.json
      --allow-caller VALUE   Exact normalized incoming identity; repeatable
      --allow-recipient VAL  Exact normalized outgoing identity; repeatable
      --input-device NAME    Exact FaceTime Microphone menu item
      --output-device NAME   Exact FaceTime Output menu item
      --call-start-timeout S Fail if outgoing call UI does not appear (default 15)
      --ringing-timeout S    End and fail unanswered outgoing calls (default 60)
      --auto-answer          Answer only positively allowlisted incoming callers
      --verbose              Include raw AX/process activity in monitor output
      --prompt               Ask macOS to show the Accessibility permission prompt
    """)
}

let options = Options(arguments: CommandLine.arguments)
if options.command == "app" || usesBridgeApplicationEntry(
    arguments: CommandLine.arguments,
    bundleIdentifier: Bundle.main.bundleIdentifier,
    bundlePath: Bundle.main.bundlePath,
    bundleExecutable: Bundle.main.object(forInfoDictionaryKey: "CFBundleExecutable") as? String
) {
    // App mode handles config errors visibly and ignores --prompt on launch.
    runBridgeApplication(arguments: CommandLine.arguments)
}
if let configError = options.configError {
    fputs("Could not load config at \(NSString(string: options.configPath).expandingTildeInPath): \(configError)\n", stderr)
    exit(2)
}
if options.prompt { _ = accessibilityTrusted(prompt: true) }

switch options.command {
case "permission":
    print(jsonString(permissionDiagnostic(), pretty: true))
case "discover":
    print(jsonString(["timestamp": timestamp(), "permission": permissionDiagnostic(), "processes": allInterestingProcesses()], pretty: true))
case "dump", "snapshot":
    guard AXIsProcessTrusted() else {
        fputs("Accessibility permission is not enabled. Use: facetime-observer permission --prompt\n", stderr)
        exit(2)
    }
    let targets = runningTargets(filter: options.filter)
    let reader = AXTreeReader(maxDepth: options.maxDepth, maxNodes: options.maxNodes)
    let output = targets.map { reader.tree(for: $0, keywords: options.keywords) }
    if options.command == "dump" {
        print(jsonString(["timestamp": timestamp(), "processes": output], pretty: true))
    } else {
        let directory = NSString(string: options.snapshotDirectory ?? "./snapshots").expandingTildeInPath
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        let path = "\(directory)/\(timestamp().replacingOccurrences(of: ":", with: "-"))-snapshot.json"
        try jsonData(["timestamp": timestamp(), "processes": output], pretty: true).write(to: URL(fileURLWithPath: path), options: .atomic)
        print(path)
    }
case "monitor":
    do {
        try runHumanMonitor(socketPath: options.socketPath, verbose: options.verbose)
    } catch {
        fputs("Monitor failed: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
case "watch", "serve":
    guard accessibilityTrusted(prompt: options.prompt) else {
        fputs("Accessibility permission is not enabled. Enable this terminal/binary in System Settings > Privacy & Security > Accessibility, restart it, then retry.\n", stderr)
        exit(2)
    }
    let service = WatchService(options: options)
    do {
        try service.start()
        RunLoop.main.run()
    } catch {
        fputs("Failed to start observer: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
default:
    printUsage()
}

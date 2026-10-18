import ApplicationServices
import Foundation

struct ScreenSharingError: LocalizedError {
    let code: String
    let message: String
    var errorDescription: String? { message }
}

struct ScreenSharingCommand {
    let name: String
    let expectedCallID: String?
    let display: String?

    init(_ command: [String: Any]) throws {
        guard command["type"] as? String == "command",
              let name = command["command"] as? String,
              ["screen.share", "screen.stop", "screen.status"].contains(name) else {
            throw ScreenSharingError(code: "invalid_command", message: "Invalid screen command")
        }
        let parameters: Set<String> = name == "screen.share" ? ["display", "expectedCallId"] :
            (name == "screen.stop" ? ["expectedCallId"] : [])
        guard Set(command.keys).isSubset(of: parameters.union(["type", "command", "id"])) else {
            throw ScreenSharingError(code: "invalid_command", message: "Unknown screen command parameter")
        }
        func safeString(_ key: String, maximum: Int) throws -> String {
            guard let value = command[key] as? String, !value.isEmpty, value.utf8.count <= maximum,
                  value == value.trimmingCharacters(in: .whitespacesAndNewlines),
                  !value.unicodeScalars.contains(where: {
                      CharacterSet.controlCharacters.contains($0) || CharacterSet.illegalCharacters.contains($0) ||
                      (0x202A...0x202E).contains($0.value) || (0x2066...0x2069).contains($0.value)
                  }) else {
                throw ScreenSharingError(code: "invalid_command", message: "\(key) must be a nonempty, bounded safe string (exact spelling required)")
            }
            return value
        }
        self.name = name
        expectedCallID = name == "screen.status" ? nil : try safeString("expectedCallId", maximum: 256)
        display = name == "screen.share" ? try safeString("display", maximum: 256) : nil
    }
}

struct ScreenSharingCall {
    let id: String?
    let phase: String
    let verified: Bool
    let identity: String?
    // A missing banner must fail closed even during CallStateTracker's end debounce.
    var present = true

    func matches(id: String, identity: String? = nil) -> Bool {
        guard present, phase == "connected", verified, self.id == id,
              let current = self.identity, !normalizedIdentity(current).isEmpty else { return false }
        return identity.map { normalizedIdentity($0) == normalizedIdentity(current) } ?? true
    }
}

// Validate a fresh read-only banner observation, not the lifecycle tracker's
// debounced observation (which intentionally retains one missing banner).
func screenSharingCall(tracker: CallStateTracker, fresh: CallObservation) -> ScreenSharingCall {
    let previous = tracker.observation.durationSeconds
    let timerContinues = fresh.durationSeconds.map { duration in previous.map { duration >= $0 } ?? false } ?? false
    return ScreenSharingCall(
        id: tracker.callID, phase: tracker.phase,
        // participantLeft is only termination evidence when the banner is
        // absent (as in CallStateTracker). It scans wider notification UI and
        // can include menu text such as "Align Left" while a valid call exists.
        verified: tracker.statusJSON["verified"] as? Bool == true && timerContinues &&
            !fresh.hasAnswer && !fresh.hasDecline && fresh.failureReason == nil,
        identity: fresh.identity, present: fresh.present
    )
}

// Value-only selection seam. Handles belong only to the most recent AX read;
// no AX elements are retained across staged/delayed actions.
struct ScreenSharingNode {
    var handle = 0
    var role = "AXGroup"
    var title: String?
    var description: String?
    var identifier: String?
    var value: String?
    var children: [ScreenSharingNode] = []

    var descendants: [ScreenSharingNode] { [self] + children.flatMap(\.descendants) }
}

struct ScreenSharingUI {
    let root: ScreenSharingNode

    static func unique(_ nodes: [ScreenSharingNode], _ label: String) throws -> ScreenSharingNode? {
        guard nodes.count <= 1 else {
            throw ScreenSharingError(code: "ambiguous_ui", message: "Multiple \(label) controls; no action taken")
        }
        return nodes.first
    }

    func panel() throws -> ScreenSharingNode? {
        try Self.unique(root.descendants.filter { $0.role == "AXWindow" && $0.title == "Control Center" }, "Control Center panel")
    }

    func picker() throws -> ScreenSharingNode? {
        try Self.unique(root.descendants.filter {
            $0.role == "AXWindow" && $0.description == "Shared Content Picker Controls"
        }, "shared content picker")
    }

    func opener() throws -> ScreenSharingNode? {
        try Self.unique(root.descendants.filter {
            $0.role == "AXMenuBarItem" && $0.identifier == "com.apple.menuextra.audiovideo"
        }, "audio/video menu bar item")
    }

    static func button(_ description: String, in node: ScreenSharingNode) throws -> ScreenSharingNode? {
        try unique(node.descendants.filter { $0.role == "AXButton" && $0.description == description }, description)
    }

    static func displayButton(_ display: String, in picker: ScreenSharingNode) throws -> ScreenSharingNode? {
        // Exact English label only, across all per-display AXHostingView groups.
        // Never choose a generic Share button, substring, coordinates, or a window/app.
        try button("Share " + display, in: picker)
    }

    static func checkbox(_ identifier: String, in panel: ScreenSharingNode) throws -> ScreenSharingNode? {
        try unique(panel.descendants.filter { $0.role == "AXCheckBox" && $0.identifier == identifier }, identifier)
    }

    static func callIdentities(in panel: ScreenSharingNode) -> [String] {
        panel.descendants.compactMap { node in
            guard node.role == "AXButton", let text = node.description,
                  let range = text.range(of: ", FaceTime") else { return nil }
            let suffix = text[range.upperBound...].split(whereSeparator: \.isWhitespace).joined(separator: " ")
            guard suffix == "Audio" || suffix == "Video" else { return nil }
            return String(text[..<range.lowerBound])
        }
    }

    static func verifyIdentity(_ identity: String, in panel: ScreenSharingNode) throws -> Bool {
        let identities = callIdentities(in: panel)
        guard identities.count <= 1 else {
            throw ScreenSharingError(code: "ambiguous_ui", message: "Multiple FaceTime calls in Control Center")
        }
        guard let actual = identities.first else { return false }
        guard normalizedIdentity(actual) == normalizedIdentity(identity) else {
            throw ScreenSharingError(code: "call_identity_mismatch", message: "Control Center FaceTime identity does not match the current call")
        }
        return true
    }

    static func active(in panel: ScreenSharingNode) throws -> Bool? {
        let toggle = try checkbox("facetime-share-toggle", in: panel)
        let currentlySharing = panel.descendants.contains { $0.role == "AXStaticText" && $0.value == "Currently Sharing" }
        let stop = try button("Stop Sharing", in: panel)
        if toggle?.value == "1", currentlySharing { return true }
        if toggle?.value == "0", !currentlySharing, stop == nil { return false }
        return nil
    }
}

protocol ScreenSharingAX: AnyObject {
    func read() throws -> ScreenSharingUI
    func press(_ node: ScreenSharingNode) throws
}

// The only native boundary: strictly ControlCenter, AXPress only, bounded reads.
// A partial/truncated tree is an error, never evidence that a control is unique.
final class ControlCenterScreenSharingAX: ScreenSharingAX {
    private var elements: [Int: AXUIElement] = [:]

    func read() throws -> ScreenSharingUI {
        elements.removeAll()
        let targets = runningTargets(filter: TargetFilter()).filter { $0.bundleIdentifier == "com.apple.controlcenter" }
        guard targets.count == 1, let target = targets.first else {
            throw ScreenSharingError(code: "screen_ui_unavailable", message: "A unique ControlCenter process is required")
        }
        let root = AXUIElementCreateApplication(target.pid)
        AXUIElementSetMessagingTimeout(root, 0.08)
        let deadline = ProcessInfo.processInfo.systemUptime + 0.25
        var visited: [AXUIElement] = []
        func attributes(_ element: AXUIElement, includeWindows: Bool) throws -> [String: CFTypeRef] {
            // One IPC per node, not seven sequential AX requests per poll.
            let names = ["AXRole", "AXTitle", "AXDescription", "AXIdentifier", "AXValue", "AXChildren"] + (includeWindows ? ["AXWindows"] : [])
            var raw: CFArray?
            let result = AXUIElementCopyMultipleAttributeValues(element, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &raw)
            guard result == .success, let values = raw as? [Any], values.count == names.count else {
                throw ScreenSharingError(code: "screen_ui_unavailable", message: "ControlCenter AX read failed: \(axErrorName(result))")
            }
            var output: [String: CFTypeRef] = [:]
            for (name, rawValue) in zip(names, values) {
                let value = rawValue as CFTypeRef
                if CFGetTypeID(value) == CFNullGetTypeID() { continue }
                if CFGetTypeID(value) == AXValueGetTypeID() {
                    let axValue = unsafeBitCast(value, to: AXValue.self)
                    if AXValueGetType(axValue) == .axError {
                        var error = AXError.failure
                        guard AXValueGetValue(axValue, .axError, &error),
                              error == .attributeUnsupported || error == .noValue else {
                            throw ScreenSharingError(code: "screen_ui_unavailable", message: "Incomplete ControlCenter AX read: \(axErrorName(error))")
                        }
                        continue
                    }
                }
                output[name] = value
            }
            return output
        }
        func visit(_ element: AXUIElement, depth: Int) throws -> ScreenSharingNode? {
            guard ProcessInfo.processInfo.systemUptime < deadline, elements.count < 2_000, depth <= 24 else {
                throw ScreenSharingError(code: "screen_ui_unavailable", message: "ControlCenter AX read exceeded its bounds")
            }
            guard !visited.contains(where: { CFEqual($0, element) }) else { return nil }
            visited.append(element)
            let handle = elements.count + 1
            elements[handle] = element
            let values = try attributes(element, includeWindows: depth == 0)
            var node = ScreenSharingNode(handle: handle,
                role: values["AXRole"] as? String ?? "",
                title: values["AXTitle"] as? String,
                description: values["AXDescription"] as? String,
                identifier: values["AXIdentifier"] as? String,
                value: (values["AXValue"] as? String) ?? (values["AXValue"] as? NSNumber)?.stringValue)
            let children = values["AXChildren"] as? [AXUIElement] ?? []
            // Windows are not always included in the application AXChildren.
            let windows = values["AXWindows"] as? [AXUIElement] ?? []
            for child in children + windows {
                if let childNode = try visit(child, depth: depth + 1) { node.children.append(childNode) }
            }
            guard ProcessInfo.processInfo.systemUptime < deadline else {
                throw ScreenSharingError(code: "screen_ui_unavailable", message: "ControlCenter AX read timed out")
            }
            return node
        }
        guard let node = try visit(root, depth: 0) else {
            throw ScreenSharingError(code: "screen_ui_unavailable", message: "No ControlCenter AX root")
        }
        return ScreenSharingUI(root: node)
    }

    func press(_ node: ScreenSharingNode) throws {
        guard let element = elements[node.handle] else {
            throw ScreenSharingError(code: "screen_action_failed", message: "Expired AX handle")
        }
        var actions: CFArray?
        guard AXUIElementCopyActionNames(element, &actions) == .success,
              (actions as? [String] ?? []).contains("AXPress") else {
            throw ScreenSharingError(code: "screen_action_failed", message: "Control does not support AXPress")
        }
        if node.role == "AXCheckBox" {
            // Recheck the direction immediately at the native mutation boundary.
            // A stale ON snapshot must never turn an already-OFF control ON.
            let required: String
            switch node.identifier {
            case "allow-remote-control-toggle": required = "1"
            case "facetime-share-toggle": required = "0"
            default: throw ScreenSharingError(code: "screen_action_failed", message: "Unrecognized sharing checkbox")
            }
            var raw: CFTypeRef?
            guard AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &raw) == .success,
                  ((raw as? String) ?? (raw as? NSNumber)?.stringValue) == required else {
                throw ScreenSharingError(code: "screen_action_failed", message: "Checkbox state changed before AXPress; not toggled")
            }
        }
        let result = AXUIElementPerformAction(element, kAXPressAction as CFString)
        guard result == .success else {
            throw ScreenSharingError(code: "screen_action_failed", message: "AXPress failed: \(axErrorName(result)); not retried")
        }
    }
}

// Main-queue controller. Busy requests are rejected, not queued/replayed. All
// waits poll read-only state; each mutation has a one-shot key even on AX error.
final class ScreenSharingController {
    typealias Completion = (Result<[String: Any], ScreenSharingError>) -> Void
    typealias Schedule = (TimeInterval, @escaping () -> Void) -> Void
    private enum Phase { case prepare, picker, reopen, controlOff, stop, cleanup }
    private final class Operation {
        let command: ScreenSharingCommand
        let identity: String
        let started: TimeInterval
        let completion: Completion
        var phase = Phase.prepare
        var mutations = Set<String>()
        var shareAttempted = false
        var failure: ScreenSharingError?
        var evidence = "no UI read yet"
        init(command: ScreenSharingCommand, identity: String, started: TimeInterval, completion: @escaping Completion) {
            self.command = command; self.identity = identity; self.started = started; self.completion = completion
        }
    }
    private let ax: ScreenSharingAX
    private let currentCall: () -> ScreenSharingCall
    private let isRunning: () -> Bool
    private let now: () -> TimeInterval
    private let schedule: Schedule
    private let verificationTimeout: TimeInterval
    private let totalTimeout: TimeInterval
    private var operation: Operation?
    private var invalidated = false
    private var owned: (id: String, identity: String, display: String)?

    init(ax: ScreenSharingAX, currentCall: @escaping () -> ScreenSharingCall, isRunning: @escaping () -> Bool,
         now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
         schedule: @escaping Schedule = { delay, action in DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: action) },
         verificationTimeout: TimeInterval = 12, cleanupTimeout: TimeInterval = 3) {
        precondition(verificationTimeout > 0 && verificationTimeout.isFinite && cleanupTimeout > 0 && cleanupTimeout.isFinite)
        self.ax = ax; self.currentCall = currentCall; self.isRunning = isRunning; self.now = now; self.schedule = schedule
        self.verificationTimeout = verificationTimeout
        self.totalTimeout = verificationTimeout + cleanupTimeout
    }

    func invalidate() {
        invalidated = true
        operation = nil
        owned = nil
    }

    func execute(_ command: ScreenSharingCommand, completion: @escaping Completion) {
        guard !invalidated, isRunning() else {
            completion(.failure(ScreenSharingError(code: "service_stopped", message: "Screen sharing service is stopped")))
            return
        }
        if command.name == "screen.status" {
            completion(.success(status()))
            return
        }
        let call = currentCall()
        guard let id = command.expectedCallID, call.matches(id: id), let identity = call.identity else {
            completion(.failure(staleCall()))
            return
        }
        guard operation == nil else {
            completion(.failure(ScreenSharingError(code: "screen_busy", message: "Another screen sharing action is in progress; not queued")))
            return
        }
        let op = Operation(command: command, identity: identity, started: now(), completion: completion)
        operation = op
        // Ingress checks happen synchronously; all UI stages start asynchronously.
        later(op, delay: 0)
    }

    private func status() -> [String: Any] {
        let unknown: [String: Any] = ["verified": false, "active": NSNull()]
        do {
            let call = currentCall()
            guard let id = call.id, call.matches(id: id), let identity = call.identity,
                  let panel = try ax.read().panel(), try ScreenSharingUI.verifyIdentity(identity, in: panel),
                  currentCall().matches(id: id, identity: identity), let active = try ScreenSharingUI.active(in: panel) else {
                owned = nil
                return unknown
            }
            let remote = try ScreenSharingUI.checkbox("allow-remote-control-toggle", in: panel)?.value
            // For an active share, verified means the view-only invariant is
            // established, not merely that an unsafe ON value was readable.
            var result: [String: Any] = ["verified": !active || remote == "0", "active": active]
            if active, remote == "0" || remote == "1" { result["remoteControl"] = remote == "1" }
            // The picker action proves the initial target, not later manual
            // switches. Never label a cached display name as currently verified.
            if !active { owned = nil }
            return result
        } catch {
            owned = nil
            return unknown
        }
    }

    private func staleCall() -> ScreenSharingError {
        ScreenSharingError(code: "stale_call", message: "A verified connected current call with the same expectedCallId and identity is required")
    }

    private func guardCall(_ op: Operation) throws {
        guard !invalidated, isRunning(), operation === op else {
            throw ScreenSharingError(code: "service_stopped", message: "Screen sharing operation was invalidated")
        }
        guard currentCall().matches(id: op.command.expectedCallID!, identity: op.identity) else { throw staleCall() }
    }

    private func later(_ op: Operation, delay: TimeInterval = 0.15) {
        schedule(delay) { [weak self, weak op] in
            guard let self, let op, !self.invalidated, self.isRunning(), self.operation === op else { return }
            self.tick(op)
        }
    }

    private func press(_ node: ScreenSharingNode, key: String, op: Operation) throws {
        try guardCall(op)
        guard now() - op.started < totalTimeout, op.mutations.insert(key).inserted else {
            throw ScreenSharingError(code: "screen_action_failed", message: "Screen action expired or already attempted; not retried")
        }
        try ax.press(node)
    }

    // Returns nil while a one-shot panel/tab action is animating. A mismatched
    // FaceTime call is a hard failure, never an invitation to switch/take over.
    private func trustedPanel(_ ui: ScreenSharingUI, purpose: String, op: Operation) throws -> ScreenSharingNode? {
        guard let panel = try ui.panel() else {
            if !op.mutations.contains("open-" + purpose), let opener = try ui.opener() {
                try press(opener, key: "open-" + purpose, op: op)
            }
            return nil
        }
        if try ScreenSharingUI.verifyIdentity(op.identity, in: panel) { return panel }
        if !op.mutations.contains("tab-" + purpose), let tab = try ScreenSharingUI.button("FaceTime", in: panel) {
            try press(tab, key: "tab-" + purpose, op: op)
        }
        return nil
    }

    private func tick(_ op: Operation) {
        do {
            try guardCall(op)
            let elapsed = now() - op.started
            // macOS picker, sharing-start and panel animations take several
            // seconds. Reserve a separate safety-stop budget; the sharing IPC
            // deadline is 20s, independently of ordinary 5s call commands.
            guard elapsed < (op.phase == .cleanup ? totalTimeout : verificationTimeout) else {
                throw ScreenSharingError(code: "screen_timeout", message:
                    "Screen sharing verification timed out at \(op.phase) (\(op.evidence); attempted: \(op.mutations.sorted().joined(separator: ", "))); mutations are not retried")
            }
            let ui = try ax.read()
            try guardCall(op)
            let panel = try ui.panel()
            let active = try panel.flatMap { try ScreenSharingUI.active(in: $0) }
            let control = try panel.flatMap { try ScreenSharingUI.checkbox("allow-remote-control-toggle", in: $0)?.value }
            op.evidence = "panel=\(panel != nil), picker=\(try ui.picker() != nil), sharing=\(active.map(String.init) ?? "unknown"), control=\(control == "0" ? "off" : control == "1" ? "on" : "unavailable")"
            switch op.phase {
            case .prepare:
                guard try ui.picker() == nil else {
                    throw ScreenSharingError(code: "screen_picker_present", message: "An existing content picker is open; refusing to take it over")
                }
                if let panel = try trustedPanel(ui, purpose: "prepare", op: op) {
                    let active = try ScreenSharingUI.active(in: panel)
                    if op.command.name == "screen.stop" {
                        owned = nil
                        if active == false { try succeed(op, result: ["active": false, "verified": true]); return }
                        if let stop = try ScreenSharingUI.button("Stop Sharing", in: panel) {
                            try press(stop, key: "stop", op: op)
                            op.phase = .stop
                        }
                    } else {
                        // Reject even inconsistent evidence of an existing share.
                        let toggle = try ScreenSharingUI.checkbox("facetime-share-toggle", in: panel)
                        let stop = try ScreenSharingUI.button("Stop Sharing", in: panel)
                        if active == true || toggle?.value == "1" ||
                            panel.descendants.contains(where: { $0.value == "Currently Sharing" }) || stop != nil {
                            throw ScreenSharingError(code: "screen_already_active", message: "An existing share is present; refusing to switch its content")
                        }
                        if active == false, let toggle {
                            owned = nil
                            op.shareAttempted = true // An AX error can still have performed the mutation.
                            try press(toggle, key: "share-toggle", op: op)
                            op.phase = .picker
                        }
                    }
                }
            case .picker:
                if let picker = try ui.picker(), let button = try ScreenSharingUI.displayButton(op.command.display!, in: picker) {
                    try press(button, key: "display", op: op)
                    op.phase = .reopen
                }
            case .reopen, .controlOff:
                // Do not toggle the panel opener while the picker is dismissing.
                if try ui.picker() == nil, let panel = try trustedPanel(ui, purpose: "verify", op: op),
                   try ScreenSharingUI.active(in: panel) == true,
                   let control = try ScreenSharingUI.checkbox("allow-remote-control-toggle", in: panel) {
                    if control.value == "0" {
                        owned = (op.command.expectedCallID!, op.identity, op.command.display!)
                        try succeed(op, result: ["active": true, "display": op.command.display!, "remoteControl": false, "verified": true])
                        return
                    }
                    if control.value == "1", !op.mutations.contains("control-off") {
                        // Fresh shares default ON. Never claim zero-time view-only;
                        // success is possible only after a subsequent read proves OFF.
                        try press(control, key: "control-off", op: op)
                        op.phase = .controlOff
                    }
                }
            case .stop:
                if let panel = try trustedPanel(ui, purpose: "stop-verify", op: op), try ScreenSharingUI.active(in: panel) == false {
                    try succeed(op, result: ["active": false, "verified": true]); return
                }
            case .cleanup:
                // Reuse the verification opener/tab keys: cleanup must not
                // retry a failed post-share panel mutation under a new name.
                if let panel = try trustedPanel(ui, purpose: "verify", op: op) {
                    if try ScreenSharingUI.active(in: panel) == false {
                        finish(op, .failure(ScreenSharingError(code: op.failure!.code, message: op.failure!.message + "; sharing verified stopped")))
                        return
                    }
                    if !op.mutations.contains("stop"), let stop = try ScreenSharingUI.button("Stop Sharing", in: panel) {
                        try press(stop, key: "stop", op: op)
                    }
                }
            }
            later(op)
        } catch {
            fail(op, error: (error as? ScreenSharingError) ?? ScreenSharingError(code: "screen_action_failed", message: error.localizedDescription))
        }
    }

    private func succeed(_ op: Operation, result: [String: Any]) throws {
        try guardCall(op)
        finish(op, .success(result))
    }

    private func fail(_ op: Operation, error: ScreenSharingError) {
        owned = nil
        if op.phase != .cleanup, op.shareAttempted, error.code != "stale_call", now() - op.started < totalTimeout {
            op.failure = error
            op.phase = .cleanup
            later(op, delay: 0)
        } else if op.phase == .cleanup, error.code == "screen_ui_unavailable", now() - op.started < totalTimeout {
            // Read failures may be transient while the panel animates. Retrying
            // these reads cannot replay a mutation, including the safety stop.
            later(op)
        } else {
            let failure = op.failure.map {
                ScreenSharingError(code: $0.code, message: $0.message + "; safety stop not verified: " + error.message)
            } ?? error
            finish(op, .failure(failure))
        }
    }

    private func finish(_ op: Operation, _ result: Result<[String: Any], ScreenSharingError>) {
        guard operation === op, !invalidated, isRunning() else { return }
        operation = nil
        op.completion(result)
    }
}

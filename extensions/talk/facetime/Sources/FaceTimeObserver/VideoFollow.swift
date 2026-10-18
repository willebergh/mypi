import Foundation

// Raw preview ratios for two PHONE poses under one fixed MAC camera axis.
// The vertical profile is measured independently, never derived by inversion.
struct VideoFollowProfile: Codable {
    var portrait: Double?
    var landscape: Double?
    var complete: Bool {
        guard let portrait, let landscape, portrait > 0, landscape > 0 else { return false }
        return abs(log(portrait / landscape)) > 0.10
    }
    func target(for ratio: Double) -> String? {
        guard complete, ratio.isFinite, ratio > 0, let portrait, let landscape else { return nil }
        let p = abs(log(ratio / portrait)), l = abs(log(ratio / landscape))
        guard min(p, l) < 0.04, abs(p - l) > 0.025 else { return nil }
        return p < l ? "portrait" : "landscape"
    }
}

struct VideoFollowCalibration: Codable {
    var macLandscape = VideoFollowProfile()
    var macPortrait = VideoFollowProfile()
    var complete: Bool { macLandscape.complete && macPortrait.complete }
    static func localAxis(_ ratio: Double) -> String? {
        guard ratio.isFinite, ratio > 0 else { return nil }
        return ratio > 1.08 ? "landscape" : ratio < 0.92 ? "portrait" : nil
    }
    func target(for ratio: Double) -> String? {
        // Even a supported axis must not start auto-rotation into an unmeasured
        // destination axis. All four samples are required for follow mode.
        guard complete, let axis = Self.localAxis(ratio) else { return nil }
        return (axis == "landscape" ? macLandscape : macPortrait).target(for: ratio)
    }
    mutating func record(orientation: String, ratio: Double, localAxis: String) {
        if localAxis == "landscape" {
            if orientation == "portrait" { macLandscape.portrait = ratio } else { macLandscape.landscape = ratio }
        } else {
            if orientation == "portrait" { macPortrait.portrait = ratio } else { macPortrait.landscape = ratio }
        }
    }
    var progress: [String: Any] {
        ["macLandscape": ["phonePortrait": macLandscape.portrait != nil, "phoneLandscape": macLandscape.landscape != nil, "complete": macLandscape.complete],
         "macPortrait": ["phonePortrait": macPortrait.portrait != nil, "phoneLandscape": macPortrait.landscape != nil, "complete": macPortrait.complete]]
    }
    private enum CodingKeys: String, CodingKey {
        case macLandscape, macPortrait, portrait, landscape, portraitLocalAxis, landscapeLocalAxis
    }
    init(macLandscape: VideoFollowProfile = VideoFollowProfile(), macPortrait: VideoFollowProfile = VideoFollowProfile()) {
        self.macLandscape = macLandscape; self.macPortrait = macPortrait
    }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        if values.contains(.macLandscape) || values.contains(.macPortrait) {
            macLandscape = try values.decodeIfPresent(VideoFollowProfile.self, forKey: .macLandscape) ?? VideoFollowProfile()
            macPortrait = try values.decodeIfPresent(VideoFollowProfile.self, forKey: .macPortrait) ?? VideoFollowProfile()
        } else {
            // Migrate v1 samples ONLY into their recorded Mac-axis profile.
            // A missing capture axis cannot justify any inferred sample.
            for (valueKey, axisKey, orientation) in [(CodingKeys.portrait, CodingKeys.portraitLocalAxis, "portrait"), (.landscape, .landscapeLocalAxis, "landscape")] {
                if let shape = try values.decodeIfPresent(Double.self, forKey: valueKey),
                   let axis = try values.decodeIfPresent(String.self, forKey: axisKey),
                   ["portrait", "landscape"].contains(axis), shape.isFinite, shape >= 1.1, shape <= 8 {
                    record(orientation: orientation, ratio: axis == "landscape" ? shape : 1 / shape, localAxis: axis)
                }
            }
        }
    }
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(macLandscape, forKey: .macLandscape)
        try values.encode(macPortrait, forKey: .macPortrait)
    }
}

struct VideoFollowSettings: Codable {
    var version = 2
    var enabled = false
    var calibrations: [String: VideoFollowCalibration] = [:]
    init(enabled: Bool = false, calibrations: [String: VideoFollowCalibration] = [:]) {
        self.enabled = enabled; self.calibrations = calibrations
    }
    private enum CodingKeys: String, CodingKey { case version, enabled, calibrations }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let previousVersion = try values.decode(Int.self, forKey: .version)
        guard [1, 2].contains(previousVersion) else { throw videoFollowError("Unsupported follow preferences version") }
        let previousEnabled = try values.decode(Bool.self, forKey: .enabled)
        calibrations = try values.decode([String: VideoFollowCalibration].self, forKey: .calibrations)
        // Old two-sample preferences never automatically authorize the new
        // four-state matcher. Keep their known samples, but require re-enable.
        enabled = previousVersion == 2 && previousEnabled
    }
    func validate() throws {
        guard version == 2, calibrations.count <= 128 else { throw videoFollowError("Invalid follow preferences version or size") }
        for (peer, calibration) in calibrations {
            guard !peer.isEmpty, peer.utf8.count <= 512 else { throw videoFollowError("Invalid peer calibration") }
            for (axis, profile) in [("landscape", calibration.macLandscape), ("portrait", calibration.macPortrait)] {
                guard [profile.portrait, profile.landscape].compactMap({ $0 }).allSatisfy({
                    $0.isFinite && $0 >= 0.125 && $0 <= 8 && VideoFollowCalibration.localAxis($0) == axis
                }) else { throw videoFollowError("Calibration ratio does not match its Mac-axis profile") }
            }
        }
    }
}

func videoFollowError(_ message: String) -> VideoLayoutError {
    VideoLayoutError(code: "video_follow_invalid", message: message)
}

// Non-authorizing UI preferences only. The current shared caller allowlist is
// checked independently before every automatic action. Custom talk.json paths
// get separate profiles; CLI and GUI use the same stable preferences domain.
struct VideoFollowStore {
    let defaults: UserDefaults?
    let key: String
    static func preferences(bundleIdentifier: String?, standard: UserDefaults = .standard,
                            suite: (String) -> UserDefaults? = { UserDefaults(suiteName: $0) }) -> UserDefaults? {
        // Foundation deliberately rejects a suite matching the running app's
        // own bundle identifier. That app must use standard preferences.
        bundleIdentifier == "dev.mypi.facetime-bridge" ? standard : suite("dev.mypi.facetime-bridge")
    }
    init(configPath: String, defaults: UserDefaults? = nil) {
        self.defaults = defaults ?? Self.preferences(bundleIdentifier: Bundle.main.bundleIdentifier)
        self.key = "videoFollow:" + URL(fileURLWithPath: configPath).standardizedFileURL.path
    }
    func load() throws -> VideoFollowSettings {
        guard let defaults else { throw videoFollowError("Video follow preferences domain is unavailable") }
        guard let data = defaults.data(forKey: key) else { return VideoFollowSettings() }
        guard data.count <= 64 * 1024 else { throw videoFollowError("Follow preferences exceed 64 KiB") }
        let settings = try JSONDecoder().decode(VideoFollowSettings.self, from: data)
        try settings.validate()
        return settings
    }
    func save(_ settings: VideoFollowSettings) throws {
        guard let defaults else { throw videoFollowError("Video follow preferences domain is unavailable") }
        try settings.validate()
        let data = try JSONEncoder().encode(settings)
        guard data.count <= 64 * 1024 else { throw videoFollowError("Follow preferences exceed 64 KiB") }
        defaults.set(data, forKey: key)
    }
}

struct VideoFollowAction {
    let windowID: String
    let peer: String
    let target: String
    var command: [String: Any] {
        ["type": "command", "command": "video.rotate", "expectedWindowId": windowID, "expectedPeer": peer]
    }
}

final class VideoFollowController {
    typealias Rotate = (VideoFollowAction, @escaping (Result<[String: Any], VideoLayoutError>) -> Void) -> Void
    private(set) var settings: VideoFollowSettings
    private let save: (VideoFollowSettings) throws -> Void
    private let allowed: (String) -> Bool
    private let rotate: Rotate
    private let emit: ([String: Any]) -> Void
    private let now: () -> TimeInterval
    private var invalidated = false
    private var context: String?
    private var missingObservation = false
    private var candidate: String?
    private var candidateSince: TimeInterval = 0
    private var samples = 0
    private var cooldownUntil: TimeInterval = 0
    private var blockedTarget: String?
    private var selfCausedShape: Double?
    private var selfCausedTarget: String?
    private var inFlight = false
    private var epoch = 0
    private(set) var phase = "disabled"
    private let loadError: String?

    init(settings: VideoFollowSettings, loadError: String? = nil,
         save: @escaping (VideoFollowSettings) throws -> Void,
         allowed: @escaping (String) -> Bool, rotate: @escaping Rotate,
         emit: @escaping ([String: Any]) -> Void,
         now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.settings = settings; self.loadError = loadError; self.save = save; self.allowed = allowed
        self.rotate = rotate; self.emit = emit; self.now = now
        phase = loadError == nil ? (settings.enabled ? "waiting_for_video" : "disabled") : "preferences_error"
    }
    func invalidate() { invalidated = true; epoch += 1; resetContext() }
    private func resetContext() {
        context = nil; candidate = nil; samples = 0; blockedTarget = nil; missingObservation = false
        cooldownUntil = 0; selfCausedShape = nil; selfCausedTarget = nil
    }
    var status: [String: Any] {
        var result: [String: Any] = ["enabled": settings.enabled, "phase": phase,
                                    "calibratedPeers": settings.calibrations.filter { $0.value.complete }.count,
                                    "profiles": settings.calibrations.mapValues { $0.progress },
                                    "source": "calibrated_local_preview_geometry", "inFlight": inFlight]
        if let loadError { result["error"] = loadError }
        return result
    }
    func setEnabled(_ enabled: Bool) throws {
        guard !invalidated, loadError == nil else { throw videoFollowError("Follow controller is unavailable; repair preferences and restart") }
        guard !enabled || settings.calibrations.values.contains(where: { $0.complete }) else {
            throw videoFollowError("Calibrate phone portrait and landscape with the Mac preview BOTH horizontal and vertical before enabling follow mode")
        }
        var next = settings; next.enabled = enabled
        try save(next); settings = next
        epoch += 1; resetContext()
        phase = enabled ? "waiting_for_video" : "disabled"
    }
    func calibrate(orientation: String, layout: VideoLayout, expectedWindowID: String, expectedPeer: String, expectedLocalAxis: String? = nil) throws -> [String: Any] {
        guard !invalidated, loadError == nil, ["portrait", "landscape"].contains(orientation),
              layout.matches(windowID: expectedWindowID, peer: expectedPeer), allowed(layout.peer), !inFlight else {
            throw videoFollowError("Calibration requires a current allowlisted video view, portrait/landscape label, and no pending rotation")
        }
        let shape = max(layout.localPreview.aspectRatio, 1 / layout.localPreview.aspectRatio)
        guard shape >= 1.1, shape <= 8 else { throw videoFollowError("Preview shape is not suitable for calibration") }
        var next = settings
        let peer = normalizedIdentity(layout.peer)
        var calibration = next.calibrations[peer] ?? VideoFollowCalibration()
        let ratio = layout.localPreview.aspectRatio
        let localAxis = ratio > 1.08 ? "landscape" : ratio < 0.92 ? "portrait" : "unknown"
        guard localAxis != "unknown" else { throw videoFollowError("Cannot calibrate a square/ambiguous local camera axis") }
        guard expectedLocalAxis == nil || expectedLocalAxis == localAxis else {
            throw videoFollowError("Mac preview axis changed; refusing to write the wrong calibration profile")
        }
        calibration.record(orientation: orientation, ratio: ratio, localAxis: localAxis)
        next.calibrations[peer] = calibration
        // Each calibration action pauses persisted automation. Enable only after
        // both deliberate, distinct samples have been checked by the user.
        next.enabled = false
        try save(next); settings = next
        epoch += 1; resetContext(); phase = "disabled"
        return ["peer": layout.peer, "orientation": orientation, "localAxis": localAxis, "shape": shape,
                "aspectRatio": ratio, "profiles": calibration.progress,
                "complete": calibration.complete, "enabled": false]
    }
    func permits(_ layout: VideoLayout, action: VideoFollowAction, afterAttempt: Bool) -> Bool {
        let ratio = layout.localPreview.aspectRatio
        let wrongAxis = action.target == "portrait" ? ratio > 1.08 : ratio < 0.92
        return !invalidated && !missingObservation && loadError == nil && settings.enabled &&
            layout.matches(windowID: action.windowID, peer: action.peer) && allowed(layout.peer) &&
            (afterAttempt || (wrongAxis && settings.calibrations[normalizedIdentity(layout.peer)]?.target(for: ratio) == action.target))
    }
    private func pauseObservation() {
        if !missingObservation { epoch += 1 }
        missingObservation = true
        if inFlight { blockedTarget = candidate }
        // A transient missing AX tree must not unlock a failed/uncertain click
        // for the same peer/window/phone state when that tree reappears.
        candidate = nil; samples = 0
    }
    func observe(_ layout: VideoLayout?, manualBusy: Bool = false) {
        guard !invalidated, loadError == nil else { return }
        guard settings.enabled else { phase = "disabled"; return }
        guard let layout else {
            pauseObservation()
            phase = "waiting_for_video"; return
        }
        guard allowed(layout.peer) else {
            pauseObservation()
            phase = "caller_not_allowed"; return
        }
        let key = layout.windowID + "|" + normalizedIdentity(layout.peer)
        if context != key { epoch += 1; resetContext(); context = key }
        missingObservation = false
        guard !inFlight, !manualBusy else { phase = "rotating"; return }
        guard now() >= cooldownUntil else { phase = "cooldown"; return }
        let shape = max(layout.localPreview.aspectRatio, 1 / layout.localPreview.aspectRatio)
        if let selfCausedShape {
            if abs(log(shape / selfCausedShape)) < 0.025 {
                let ratio = layout.localPreview.aspectRatio
                let matches = selfCausedTarget == "portrait" ? ratio < 0.92 : ratio > 1.08
                phase = blockedTarget != nil ? "paused_after_failure" : matches ? "matched" : "waiting_for_device_change"
                return
            }
            // A new non-self aspect arrived; debounce it from scratch rather
            // than interpreting the camera button's own crop as phone rotation.
            self.selfCausedShape = nil; selfCausedTarget = nil
            candidate = nil; samples = 0
        }
        guard let target = settings.calibrations[normalizedIdentity(layout.peer)]?.target(for: layout.localPreview.aspectRatio) else {
            candidate = nil; samples = 0; phase = "uncalibrated_or_unknown_shape"; return
        }
        if candidate != target {
            candidate = target; candidateSince = now(); samples = 1
            if let blockedTarget, blockedTarget != target { self.blockedTarget = nil }
            phase = "debouncing"; return
        }
        samples += 1
        guard samples >= 2, now() - candidateSince >= 1 else { phase = "debouncing"; return }
        let ratio = layout.localPreview.aspectRatio
        let current = ratio > 1.08 ? "landscape" : ratio < 0.92 ? "portrait" : "unknown"
        guard current != "unknown" else { phase = "unknown_axis"; return }
        guard current != target else { phase = "matched"; return }
        guard blockedTarget != target else { phase = "paused_after_failure"; return }
        let action = VideoFollowAction(windowID: layout.windowID, peer: layout.peer, target: target)
        let token = epoch
        inFlight = true; phase = "rotating"
        emit(["type": "event", "event": "video.follow", "status": "rotating", "target": target, "peer": layout.peer, "windowId": layout.windowID])
        rotate(action) { [weak self] result in
            guard let self else { return }
            self.inFlight = false
            guard !self.invalidated, self.epoch == token, self.settings.enabled else { return }
            self.cooldownUntil = self.now() + 5
            var matched = false
            if case .success(let value) = result,
               let after = value["after"] as? [String: Any],
               after["windowId"] as? String == action.windowID,
               let peer = after["peer"] as? String, normalizedIdentity(peer) == normalizedIdentity(action.peer),
               let preview = after["localPreview"] as? [String: Any],
               let ratio = (preview["aspectRatio"] as? NSNumber)?.doubleValue,
               ratio.isFinite, ratio > 0 {
                // Rotate Camera can reset crop to an uncalibrated ratio (e.g.
                // 16:9) even though it successfully changes the axis. Verify
                // the requested axis, then quarantine that self-caused shape.
                self.selfCausedShape = max(ratio, 1 / ratio)
                self.selfCausedTarget = target
                matched = value["verifiedChange"] as? Bool == true && (target == "portrait" ? ratio < 0.92 : ratio > 1.08)
            }
            if !matched { self.blockedTarget = target }
            self.phase = matched ? "matched" : "paused_after_failure"
            self.emit(["type": "event", "event": "video.follow", "status": self.phase,
                       "target": target, "peer": action.peer, "windowId": action.windowID,
                       "verified": matched])
        }
    }
}

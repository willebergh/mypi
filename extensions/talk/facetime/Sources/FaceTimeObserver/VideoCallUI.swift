import Foundation

// Video-only, synthetic-testable selectors. No notification-banner fallback.
// Paths are ephemeral AXChildren paths, never saved or reused across requests.
struct VideoCallControl: Equatable {
    let pid: Int
    let path: [Int]
    let identity: String
    let windowID: String?
    let label: String
}

// Claims are taken before reads/actions: AX errors can still have side effects.
// A new explicit request gets a new call ID; an old request is never replayed.
struct VideoCallAttempts {
    enum Action { case confirmation, end }
    private var confirmationID: String?
    private var endID: String?
    mutating func claim(_ action: Action, callID: String) -> Bool {
        switch action {
        case .confirmation:
            guard confirmationID != callID else { return false }
            confirmationID = callID
        case .end:
            guard endID != callID else { return false }
            endID = callID
        }
        return true
    }
}

// Fixed codes only: never retain AX text, identities, raw values or paths.
// One cached observation (no history) is exposed by read-only status.
enum VideoCallDiagnostic: String {
    case notObserved = "not_observed"
    case unreadable = "unreadable_or_ambiguous_snapshot"
    case noUI = "no_video_call_ui"
    case confirmation = "confirmation_not_connection"
    case layoutUnavailable = "unique_video_layout_unavailable"
    case peerMismatch = "peer_not_allowed"
    case windowMismatch = "window_mismatch"
    case contextChanged = "tracked_context_changed"
    case ringing = "identity_matched_video_ringing"
    case participants = "identity_matched_video_participants"

    func statusJSON(tracker: CallStateTracker) -> [String: Any] {
        let gate: String
        if tracker.requestedMedia != .video { gate = "not_pending_video" }
        else if tracker.phase == "unconfirmed" { gate = "retained_failure_no_recovery" }
        else if tracker.phase == "connected" { gate = "verified_stable_video_participants" }
        else if self == .participants { gate = "waiting_for_stable_video_participants" }
        else { gate = "video_participants_unavailable" }
        return ["observation": rawValue, "connectionGate": gate]
    }
}

struct VideoCallUI {
    let pid: Int
    let tree: [String: Any]

    init?(_ snapshots: [[String: Any]]) {
        let apps = snapshots.filter { ($0["process"] as? [String: Any])?["bundleIdentifier"] as? String == "com.apple.FaceTime" }
        guard apps.count == 1, let app = apps.first, app["truncated"] as? Bool != true,
              let pid = (app["process"] as? [String: Any])?["pid"] as? Int,
              let tree = app["tree"] as? [String: Any],
              !VideoLayout.nodes(tree).contains(where: {
                  $0["childrenError"] != nil || $0["depthLimitReached"] as? Bool == true || $0["reference"] != nil
              }) else { return nil }
        self.pid = pid; self.tree = tree
    }

    static func children(_ node: [String: Any]) -> [[String: Any]] { node["children"] as? [[String: Any]] ?? [] }
    static func strings(_ node: [String: Any]) -> [String] {
        ["AXTitle", "AXDescription", "AXValue"].compactMap { node[$0] as? String }
    }
    // Unlike the legacy audio normalizer, never extract digits from prose.
    // Ignore only known bidi formatting; other invisible controls fail closed.
    static func normalizedWholeIdentity(_ value: String) -> String? {
        let bidi = CharacterSet(charactersIn: "\u{061C}\u{200E}\u{200F}\u{202A}\u{202B}\u{202C}\u{202D}\u{202E}\u{2066}\u{2067}\u{2068}\u{2069}")
        let untrimmed = value.components(separatedBy: bidi).joined()
        // Validate before trimming: Foundation's whitespace set includes some
        // invisible format characters, such as zero-width space.
        guard untrimmed.unicodeScalars.allSatisfy({
            $0.properties.generalCategory != .format &&
                (CharacterSet.whitespacesAndNewlines.contains($0) || !CharacterSet.controlCharacters.contains($0))
        }) else { return nil }
        let cleaned = untrimmed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return nil }
        let phone = CharacterSet(charactersIn: "+0123456789().-\u{2010}\u{2011}\u{2012}\u{2013}").union(.whitespacesAndNewlines)
        if cleaned.unicodeScalars.allSatisfy({ phone.contains($0) }) {
            var digits = "", hasPlus = false, inParentheses = false, groupDigits = 0
            for scalar in cleaned.unicodeScalars {
                switch scalar {
                case "+":
                    guard cleaned.first == "+", digits.isEmpty, !hasPlus, !inParentheses else { return nil }
                    hasPlus = true
                case "(":
                    guard !inParentheses else { return nil }
                    inParentheses = true; groupDigits = 0
                case ")":
                    guard inParentheses, groupDigits > 0 else { return nil }
                    inParentheses = false
                case "0"..."9":
                    digits.unicodeScalars.append(scalar); groupDigits += 1
                default: break // Only the explicit phone formatting allowlist.
                }
            }
            guard !inParentheses, (7...15).contains(digits.count) else { return nil }
            return (hasPlus ? "+" : "") + digits
        }
        // Names and email addresses remain whole fields: no prefix, substring,
        // punctuation removal, or digit extraction (even for digit-heavy names).
        return cleaned.lowercased().split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
    static func identityField(_ node: [String: Any], matches identity: String) -> Bool {
        let values = strings(node)
        return !values.isEmpty && values.allSatisfy { normalizedWholeIdentity($0) == identity }
    }
    static func labelledButton(_ node: [String: Any], _ label: String) -> Bool {
        node["AXRole"] as? String == "AXButton" && node["AXDescription"] as? String == label
    }
    static func button(_ node: [String: Any], _ label: String) -> Bool {
        labelledButton(node, label) && node["AXEnabled"] as? Bool == true &&
        (node["actions"] as? [String] ?? []).contains("AXPress")
    }
    static func walk(_ node: [String: Any], path: [Int] = []) -> [(node: [String: Any], path: [Int])] {
        [(node, path)] + children(node).enumerated().flatMap { walk($0.element, path: path + [$0.offset]) }
    }
    var hasCallUI: Bool {
        let nodes = VideoLayout.nodes(tree)
        return nodes.contains { ["ParticipantGridView", "LocalParticipantView"].contains($0["AXIdentifier"] as? String ?? "") } ||
            nodes.contains { Self.labelledButton($0, "End") } ||
            (nodes.contains { Self.labelledButton($0, "Call") } && nodes.contains { Self.labelledButton($0, "Cancel") })
    }

    // The standard-window Call/Cancel structure has no proven media label.
    // It is eligible ONLY for the sole newly launched pending video request,
    // after a clean preflight. Identity must be a whole static-text value, not
    // inferred from content, Contacts, a window title, or a substring.
    func confirmation(identities: [String], pendingVideo: Bool) -> VideoCallControl? {
        guard pendingVideo, !VideoLayout.nodes(tree).contains(where: {
            ["ParticipantGridView", "LocalParticipantView"].contains($0["AXIdentifier"] as? String ?? "") || Self.labelledButton($0, "End")
        }) else { return nil }
        let windows = Self.walk(tree).filter { $0.node["AXRole"] as? String == "AXWindow" && $0.node["AXSubrole"] as? String == "AXStandardWindow" }
        var matches: [VideoCallControl] = []
        var candidates = 0
        for window in windows {
            let nodes = Self.walk(window.node, path: window.path)
            let calls = nodes.filter { Self.labelledButton($0.node, "Call") }
            let cancels = nodes.filter { Self.labelledButton($0.node, "Cancel") }
            guard !calls.isEmpty || !cancels.isEmpty else { continue }
            candidates += 1
            guard calls.count == 1, cancels.count == 1,
                  !nodes.contains(where: { $0.node["AXIdentifier"] as? String == "ParticipantGridView" }),
                  let parentPath = calls.first?.path.dropLast(),
                  Array(parentPath) == Array(cancels[0].path.dropLast()),
                  let parent = nodes.first(where: { $0.path == Array(parentPath) })?.node else { continue }
            let contents = Self.children(parent)
            // Observed container: text group, Cancel, Call, static Cancel/Call.
            guard contents.count == 5, Self.button(contents[1], "Cancel"), Self.button(contents[2], "Call"),
                  contents[3]["AXRole"] as? String == "AXStaticText", Self.strings(contents[3]).contains("Cancel"),
                  contents[4]["AXRole"] as? String == "AXStaticText", Self.strings(contents[4]).contains("Call") else { continue }
            let textNodes = VideoLayout.nodes(contents[0]).filter { $0["AXRole"] as? String == "AXStaticText" }
            guard textNodes.count == 2 else { continue }
            let texts = textNodes.flatMap(Self.strings)
            let allowed = Set(identities.compactMap(Self.normalizedWholeIdentity))
            let identities = Set(texts.compactMap(Self.normalizedWholeIdentity)).intersection(allowed)
            // Explicit opposite media or unresolved media choices veto even a
            // structurally correct dialog. Unknown text is not media evidence.
            let labels = Set(nodes.flatMap { Self.strings($0.node) }.map { $0.replacingOccurrences(of: "\u{00a0}", with: " ").lowercased() })
            guard identities.count == 1, let identity = identities.first,
                  Self.identityField(textNodes[0], matches: identity),
                  labels.isDisjoint(with: ["facetime audio", "audio", "video", "audio call", "video call", "call audio", "call video"]) else { continue }
            matches.append(VideoCallControl(pid: pid, path: calls[0].path, identity: identity, windowID: nil, label: "Call"))
        }
        return candidates == 1 && matches.count == 1 ? matches.first : nil
    }

    func observation(snapshots: [[String: Any]], identities: [String], expectedWindowID: String?) -> CallObservation? {
        observationResult(snapshots: snapshots, identities: identities, expectedWindowID: expectedWindowID).observation
    }

    // Call tracking is deliberately independent of rotation/follow's VideoLayout
    // and its fullscreen action. In the measured ringing UI these views were
    // absent; after answer a grid, remote peer and local preview appeared.
    struct Context {
        let windowID: String
        let peer: String
        let windowPath: [Int]
    }

    func participantContext() -> Context? {
        let windows = Self.walk(tree).filter { item in
            item.node["AXRole"] as? String == "AXWindow" &&
            VideoLayout.nodes(item.node).contains { $0["AXIdentifier"] as? String == "ParticipantGridView" }
        }
        guard windows.count == 1, let window = windows.first,
              let identifier = window.node["AXIdentifier"] as? String, !identifier.isEmpty else { return nil }
        let nodes = Self.walk(window.node, path: window.path)
        let grids = nodes.filter { $0.node["AXIdentifier"] as? String == "ParticipantGridView" }
        let locals = nodes.filter { $0.node["AXIdentifier"] as? String == "LocalParticipantView" }
        guard grids.count == 1, locals.count == 1,
              grids[0].path.dropLast() == locals[0].path.dropLast(),
              let gridRect = VideoRect(grids[0].node), VideoRect(locals[0].node) != nil else { return nil }
        let remote = nodes.filter { item in
            guard item.node["AXRole"] as? String == "AXButton",
                  item.node["AXIdentifier"] as? String != "LocalParticipantView",
                  item.path.dropLast() == grids[0].path.dropLast(),
                  let rect = VideoRect(item.node),
                  let peer = item.node["AXDescription"] as? String,
                  Self.normalizedWholeIdentity(peer) != nil else { return false }
            return abs(rect.width - gridRect.width) < 1 && abs(rect.height - gridRect.height) < 1
        }
        guard remote.count == 1, let peer = remote.first?.node["AXDescription"] as? String else { return nil }
        return Context(windowID: "\(pid):\(identifier)", peer: peer, windowPath: window.path)
    }

    func observationResult(snapshots: [[String: Any]], identities: [String], expectedWindowID: String?) -> (observation: CallObservation?, diagnostic: VideoCallDiagnostic) {
        let allowed = Set(identities.compactMap(Self.normalizedWholeIdentity))
        if let context = participantContext() {
            guard let identity = Self.normalizedWholeIdentity(context.peer), allowed.contains(identity) else { return (nil, .peerMismatch) }
            guard expectedWindowID == nil || expectedWindowID == context.windowID else { return (nil, .windowMismatch) }
            var result = CallObservation(present: true, direction: "outgoing", identity: context.peer, media: "video")
            result.videoWindowID = context.windowID
            result.videoParticipantsPresent = true
            result.hasEnd = endControl(context: context) != nil
            return (result, .participants)
        }
        // Ringing also exposes End/Camera/Microphone. These controls establish
        // presence ONLY, never connection. Correlate its auxiliary whole-field
        // identity before starting the ringing deadline.
        let all = VideoLayout.nodes(tree)
        guard !all.contains(where: { ["ParticipantGridView", "LocalParticipantView"].contains($0["AXIdentifier"] as? String ?? "") }) else { return (nil, .layoutUnavailable) }
        let windows = Self.walk(tree).filter { $0.node["AXRole"] as? String == "AXWindow" }
        guard windows.count == 1, let window = windows.first,
              let identifier = window.node["AXIdentifier"] as? String, !identifier.isEmpty else { return (nil, .layoutUnavailable) }
        let contents = VideoLayout.nodes(window.node)
        guard contents.filter({ Self.button($0, "End") }).count == 1,
              ["Camera", "Microphone"].allSatisfy({ label in contents.contains { $0["AXRole"] as? String == "AXCheckBox" && $0["AXDescription"] as? String == label } }) else { return (nil, .layoutUnavailable) }
        let peers = Self.children(tree).compactMap { group -> String? in
            let children = Self.children(group)
            guard (2...3).contains(children.count), children[0]["AXRole"] as? String == "AXStaticText",
                  children[1]["AXRole"] as? String == "AXStaticText",
                  let first = Self.strings(children[0]).first, let identity = Self.normalizedWholeIdentity(first),
                  Self.identityField(children[0], matches: identity), allowed.contains(identity) else { return nil }
            return first
        }
        guard peers.count == 1 else { return (nil, .peerMismatch) }
        let windowID = "\(pid):\(identifier)"
        guard expectedWindowID == nil || expectedWindowID == windowID else { return (nil, .windowMismatch) }
        var result = CallObservation(present: true, direction: "outgoing", identity: peers[0], media: "video", hasEnd: true)
        result.videoWindowID = windowID
        return (result, .ringing)
    }

    // Keep the service's historical target guard on the same strict identity
    // path as observation/selection, never the legacy audio digit extractor.
    func endControl(expectedWindowID: String, expectedIdentity: String, identities: [String]) -> VideoCallControl? {
        guard let identity = Self.normalizedWholeIdentity(expectedIdentity),
              identities.compactMap(Self.normalizedWholeIdentity).contains(identity),
              let current = observationResult(snapshots: [], identities: identities, expectedWindowID: expectedWindowID).observation,
              current.videoWindowID == expectedWindowID,
              current.identity.flatMap(Self.normalizedWholeIdentity) == identity,
              let window = Self.walk(tree).first(where: { $0.node["AXRole"] as? String == "AXWindow" && ($0.node["AXIdentifier"] as? String).map { "\(pid):\($0)" } == expectedWindowID }) else { return nil }
        return endControl(context: Context(windowID: expectedWindowID, peer: expectedIdentity, windowPath: window.path))
    }

    func endControl(layout: VideoLayout) -> VideoCallControl? {
        guard layout.pid == pid, let context = participantContext(),
              context.windowID == layout.windowID,
              Self.normalizedWholeIdentity(context.peer) == Self.normalizedWholeIdentity(layout.peer) else { return nil }
        return endControl(context: context)
    }

    private func endControl(context: Context) -> VideoCallControl? {
        guard let identity = Self.normalizedWholeIdentity(context.peer) else { return nil }
        let windows = Self.walk(tree).filter { node, _ in
            node["AXRole"] as? String == "AXWindow" && (node["AXIdentifier"] as? String).map { "\(pid):\($0)" } == context.windowID
        }
        guard windows.count == 1 else { return nil }
        let controls = Self.walk(windows[0].node, path: windows[0].path).filter { Self.labelledButton($0.node, "End") }
        guard controls.count == 1, Self.button(controls[0].node, "End") else { return nil }
        return VideoCallControl(pid: pid, path: controls[0].path, identity: identity, windowID: context.windowID, label: "End")
    }

}

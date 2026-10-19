import Foundation

struct CallObservation: Equatable {
    var present = false
    var direction: String?
    var identity: String?
    var media: String?
    var durationSeconds: Int?
    var hasAnswer = false
    var hasDecline = false
    var hasEnd = false
    var participantLeft = false
    var failureReason: String?
    var videoWindowID: String?
    var videoParticipantsPresent = false

    static func extract(from snapshots: [[String: Any]]) -> CallObservation {
        guard let notificationCenter = snapshots.first(where: {
            let process = $0["process"] as? [String: Any]
            return process?["bundleIdentifier"] as? String == "com.apple.notificationcenterui"
        }) else { return CallObservation() }

        let allNodes = flatten(notificationCenter)
        let callRoots = allNodes.filter {
            ($0["AXIdentifier"] as? String) == "FACETIME_NOTIFICATION" ||
            ($0["AXDescription"] as? String) == "FACETIME_NOTIFICATION"
        }
        let hasCallBanner = !callRoots.isEmpty
        let callNodes = callRoots.flatMap(flatten)
        let strings = callNodes.flatMap { node in
            [node["AXTitle"], node["AXDescription"], node["AXValue"]].compactMap { $0 as? String }
        }
        let allStrings = allNodes.flatMap { node in
            [node["AXTitle"], node["AXDescription"], node["AXValue"]].compactMap { $0 as? String }
        }

        var result = CallObservation()
        let isClickToCallConfirmation = strings.contains(where: { cleanAXText($0).localizedCaseInsensitiveContains("Click to Call") })
        result.present = hasCallBanner && !isClickToCallConfirmation
        result.hasAnswer = strings.contains(where: { cleanAXText($0) == "Answer" })
        result.hasDecline = strings.contains(where: { cleanAXText($0) == "Decline" })
        result.hasEnd = strings.contains(where: { cleanAXText($0) == "End" })
        result.participantLeft = allStrings.contains(where: { cleanAXText($0).localizedCaseInsensitiveContains(" left") })
        let failureTerms = ["not available for FaceTime", "call failed", "declined", "did not answer", "unavailable"]
        result.failureReason = strings.map(cleanAXText).first(where: { text in
            failureTerms.contains(where: { text.localizedCaseInsensitiveContains($0) })
        })

        // The banner also contains an avatar labelled "FaceTime Audio" (with a
        // non-breaking space). Require the caller separator so that element is
        // never mistaken for the caller-bearing description.
        let callDescription = strings.map(cleanAXText).first(where: {
            $0.localizedCaseInsensitiveContains(", FaceTime") &&
            ($0.localizedCaseInsensitiveContains("FaceTime Audio") || $0.localizedCaseInsensitiveContains("FaceTime Audio") ||
             $0.localizedCaseInsensitiveContains("FaceTime Video") || $0.localizedCaseInsensitiveContains("FaceTime Video"))
        })
        if let description = callDescription {
            result.media = description.localizedCaseInsensitiveContains("Audio") ? "audio" : "video"
            result.identity = identityFromCallDescription(description)
            result.durationSeconds = durationFromCallDescription(description)
        }
        if result.present {
            if result.hasAnswer || result.hasDecline { result.direction = "incoming" }
            else if result.hasEnd && result.durationSeconds == nil { result.direction = "outgoing" }
        }
        return result
    }
}

struct CallConfirmation: Equatable {
    let identity: String
    let media: FaceTimeCallMedia?
    let conflictingMedia: Bool

    // Only explicit media labels in this identity-bearing banner count. Unknown
    // UI/localization is not permission to guess video from the submitted URL.
    static func fromBannerStrings(_ strings: [String]) -> CallConfirmation? {
        let cleaned = strings.map(cleanAXText)
        let identities = Set(cleaned.compactMap { description -> String? in
            guard let range = description.range(of: ", Click to Call", options: .caseInsensitive) else { return nil }
            let identity = String(description[..<range.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
            return identity.isEmpty ? nil : identity
        })
        guard identities.count == 1, let identity = identities.first else { return nil }
        let labels = Set(cleaned.map { $0.replacingOccurrences(of: "\u{00a0}", with: " ").lowercased() })
        let audio = labels.contains("facetime audio")
        let video = labels.contains("facetime video")
        // Bare Audio/Video choices are not evidence of the selected medium.
        let unresolvedChoices = !labels.isDisjoint(with: ["audio", "video", "audio call", "video call", "call audio", "call video"])
        return CallConfirmation(identity: identity, media: audio == video ? nil : audio ? .audio : .video,
                                conflictingMedia: (audio && video) || unresolvedChoices)
    }

    func permits(_ expected: FaceTimeCallMedia) -> Bool {
        guard !conflictingMedia else { return false }
        // Preserve legacy generic audio confirmation, but never click an
        // explicitly mismatched banner. Video always needs explicit evidence.
        return media == expected || (media == nil && expected == .audio)
    }

    static func extract(from snapshots: [[String: Any]]) -> CallConfirmation? {
        guard let notificationCenter = snapshots.first(where: {
            let process = $0["process"] as? [String: Any]
            return process?["bundleIdentifier"] as? String == "com.apple.notificationcenterui"
        }) else { return nil }
        let roots = flatten(notificationCenter).filter {
            ($0["AXIdentifier"] as? String) == "FACETIME_NOTIFICATION" ||
            ($0["AXDescription"] as? String) == "FACETIME_NOTIFICATION"
        }
        let confirmations = roots.compactMap { root in
            fromBannerStrings(flatten(root).flatMap { node in
                [node["AXTitle"], node["AXDescription"], node["AXValue"]].compactMap { $0 as? String }
            })
        }
        return confirmations.count == 1 ? confirmations.first : nil
    }
}

final class CallStateTracker {
    private(set) var callID: String?
    private(set) var phase = "idle"
    private(set) var observation = CallObservation()
    private(set) var requestedMedia: FaceTimeCallMedia?
    private var nextID = 1
    private var previousDuration: Int?
    private var missingCount = 0
    private var emittedUnverifiedTimer = false
    private var localHangupRequested = false
    private var videoUISeen = false
    private var retainedVideoFailure = false
    private var previousVideoContext: String?

    var statusJSON: [String: Any] {
        [
            "phase": phase,
            "callId": callID ?? NSNull(),
            "direction": observation.direction ?? NSNull(),
            "identity": observation.identity ?? NSNull(),
            "media": observation.media ?? NSNull(),
            "requestedMedia": requestedMedia?.rawValue ?? NSNull(),
            "durationSeconds": observation.durationSeconds ?? NSNull(),
            "verified": phase == "connected" && (requestedMedia == .video ? observation.videoParticipantsPresent : previousDuration != nil)
        ]
    }

    func update(_ next: CallObservation) -> [[String: Any]] {
        var events: [[String: Any]] = []

        if requestedMedia == .video, next.present, let media = next.media, media != "video" {
            return retainVideoFailure(evidence: "observed_media_mismatches_video_request").map { [$0] } ?? []
        }
        if next.present {
            missingCount = 0
            // A completed Call Failed banner can remain in Notification Centre.
            // It is evidence only for an already tracked call, never a new call.
            if next.failureReason != nil && callID == nil {
                observation = next
                return events
            }
            if callID == nil {
                callID = "local-\(nextID)"
                nextID += 1
                previousDuration = nil
                emittedUnverifiedTimer = false
            }
            if requestedMedia == .video {
                videoUISeen = true
                // Video has no timer requirement. A complete identity-matched
                // participant scene must persist across two reconciliations.
                if !next.videoParticipantsPresent { previousVideoContext = nil }
            }
            observation = merge(next, over: observation)
            if retainedVideoFailure { return events }
            if let failure = next.failureReason {
                let event = callEvent("call.failed", verified: true, evidence: failure)
                reset()
                return [event]
            }

            if requestedMedia == .video {
                let context = next.videoWindowID.flatMap { window in
                    next.identity.flatMap(VideoCallUI.normalizedWholeIdentity).map { window + "\n" + $0 }
                }
                if next.videoParticipantsPresent, let context {
                    if previousVideoContext == context {
                        if phase != "connected" {
                            phase = "connected"
                            events.append(callEvent("call.connected", verified: true, evidence: "stable_identity_matched_video_participants"))
                        }
                    } else if phase != "connected" {
                        phase = "dialing"
                        events.append(callEvent("call.unknown", verified: false, evidence: "video_participants_seen_once_waiting_for_stability"))
                    }
                    previousVideoContext = context
                } else if phase != "connected" && next.hasEnd && phase != "dialing" {
                    phase = "dialing"
                    events.append(callEvent("call.dialing", verified: true, evidence: "identity_matched_video_ringing"))
                }
                return events
            }

            if next.hasAnswer || next.hasDecline {
                if phase != "incoming" {
                    phase = "incoming"
                    events.append(callEvent("call.incoming", verified: next.identity != nil, evidence: "answer_decline_controls"))
                }
            } else if let duration = next.durationSeconds {
                if requestedMedia == .video && phase == "starting" { phase = "dialing" }
                if let previousDuration, duration > previousDuration {
                    if phase != "connected" {
                        phase = "connected"
                        events.append(callEvent("call.connected", verified: true, evidence: "advancing_duration"))
                    }
                } else if phase != "connected" && !emittedUnverifiedTimer {
                    emittedUnverifiedTimer = true
                    events.append(callEvent("call.unknown", verified: false, evidence: "duration_seen_once_waiting_for_advance"))
                }
                previousDuration = duration
            } else if next.hasEnd && phase != "connected" {
                // End can linger after a verified call's timer disappears.
                if phase != "dialing" {
                    phase = "dialing"
                    events.append(callEvent("call.dialing", verified: true, evidence: "outgoing_call_ui_without_duration"))
                }
            }
            return events
        }

        guard callID != nil else {
            observation = next
            return events
        }
        if phase == "starting" && !(requestedMedia == .video && videoUISeen) { return events }
        missingCount += 1
        if next.participantLeft || missingCount >= 2 {
            if retainedVideoFailure {
                // The earlier failure was nonterminal. Notify connected clients
                // before releasing its ID so cached unconfirmed state can clear.
                events.append(callEvent("call.ended", verified: localHangupRequested || next.participantLeft,
                                        evidence: "unconfirmed_video_ui_disappeared"))
                reset()
                return events
            }
            observation.participantLeft = next.participantLeft
            if phase == "dialing" {
                let reason = next.participantLeft ? "remote_declined_or_ended" : "call_ui_disappeared_before_connection"
                events.append(callEvent("call.failed", verified: next.participantLeft, evidence: reason))
            } else {
                let reason = localHangupRequested ? "local_hangup" : (next.participantLeft ? "participant_left" : "ui_disappeared")
                events.append(callEvent("call.ended", verified: localHangupRequested || next.participantLeft, evidence: reason))
            }
            reset()
        }
        return events
    }

    func beginOutgoingRequest(identity: String, media: FaceTimeCallMedia = .audio) -> String? {
        guard callID == nil else { return nil }
        callID = "local-\(nextID)"
        nextID += 1
        phase = "starting"
        requestedMedia = media
        observation = CallObservation(present: false, direction: "outgoing", identity: identity)
        previousDuration = nil
        missingCount = 0
        emittedUnverifiedTimer = false
        localHangupRequested = false
        return callID
    }

    func markVideoObservationUncertain() {
        guard requestedMedia == .video else { return }
        missingCount = 0
        if phase != "connected" { previousDuration = nil; previousVideoContext = nil }
    }

    func markVideoConfirmationSeen() {
        if requestedMedia == .video { videoUISeen = true }
    }

    // Report an unconfirmed video failure once, but keep ownership and block
    // new requests until two complete reads establish UI disappearance.
    func retainVideoFailure(evidence: String) -> [String: Any]? {
        guard requestedMedia == .video, callID != nil, !retainedVideoFailure else { return nil }
        retainedVideoFailure = true
        phase = "unconfirmed"
        missingCount = 0
        previousDuration = nil
        return callEvent("call.failed", verified: false, evidence: evidence)
    }

    func markLocalHangupRequested() {
        localHangupRequested = true
    }

    func forceFailed(evidence: String) -> [String: Any]? {
        guard callID != nil else { return nil }
        let event = callEvent("call.failed", verified: true, evidence: evidence)
        reset()
        return event
    }

    private func callEvent(_ name: String, verified: Bool, evidence: String) -> [String: Any] {
        var event: [String: Any] = [
            "type": "event",
            "event": name,
            "callId": callID ?? NSNull(),
            "direction": observation.direction ?? NSNull(),
            "identity": observation.identity ?? NSNull(),
            "media": observation.media ?? NSNull(),
            "requestedMedia": requestedMedia?.rawValue ?? NSNull(),
            "durationSeconds": observation.durationSeconds ?? NSNull(),
            "verified": verified,
            "evidence": evidence
        ]
        // status survives the protocol-1 semantic-event filter. Only a retained
        // failure is nonterminal; audio keeps its existing terminal meaning.
        if name == "call.failed" || name == "call.ended" {
            event["status"] = name == "call.failed" && retainedVideoFailure ? "retained" : "terminal"
        }
        return event
    }

    private func reset() {
        callID = nil
        phase = "idle"
        observation = CallObservation()
        requestedMedia = nil
        previousDuration = nil
        missingCount = 0
        emittedUnverifiedTimer = false
        localHangupRequested = false
        videoUISeen = false
        retainedVideoFailure = false
        previousVideoContext = nil
    }

    private func merge(_ new: CallObservation, over old: CallObservation) -> CallObservation {
        var result = new
        result.direction = new.direction ?? old.direction
        result.identity = new.identity ?? old.identity
        result.media = new.media ?? old.media
        return result
    }
}

func normalizedIdentity(_ value: String) -> String {
    let cleaned = cleanAXText(value).lowercased()
    if cleaned.contains("@") { return cleaned }
    let phoneCharacters = cleaned.filter { $0.isNumber || $0 == "+" }
    if phoneCharacters.filter(\.isNumber).count >= 7 { return phoneCharacters }
    return cleaned.split(whereSeparator: \.isWhitespace).joined(separator: " ")
}

private func flatten(_ root: Any) -> [[String: Any]] {
    var result: [[String: Any]] = []
    func visit(_ value: Any) {
        if let dictionary = value as? [String: Any] {
            result.append(dictionary)
            for child in dictionary.values { visit(child) }
        } else if let array = value as? [Any] {
            for child in array { visit(child) }
        }
    }
    visit(root)
    return result
}

private func cleanAXText(_ value: String) -> String {
    let ignored = CharacterSet(charactersIn: "\u{202A}\u{202B}\u{202C}\u{202D}\u{202E}\u{2066}\u{2067}\u{2068}\u{2069}")
    return value.components(separatedBy: ignored).joined().trimmingCharacters(in: .whitespacesAndNewlines)
}

private func identityFromCallDescription(_ description: String) -> String? {
    let lower = description.lowercased()
    guard let range = lower.range(of: ", facetime") else { return nil }
    let identity = String(description[..<range.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
    return identity.isEmpty ? nil : identity
}

private func durationFromCallDescription(_ description: String) -> Int? {
    guard let regex = try? NSRegularExpression(pattern: #"(?:^|\D)(\d+):(\d{2})(?:\D|$)"#),
          let match = regex.firstMatch(in: description, range: NSRange(description.startIndex..., in: description)),
          let minutesRange = Range(match.range(at: 1), in: description),
          let secondsRange = Range(match.range(at: 2), in: description),
          let minutes = Int(description[minutesRange]),
          let seconds = Int(description[secondsRange]) else { return nil }
    return minutes * 60 + seconds
}

private extension ComparisonResult {
    var isOrderedSame: Bool { self == .orderedSame }
}

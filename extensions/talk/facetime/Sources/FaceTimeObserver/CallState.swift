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

    static func extract(from snapshots: [[String: Any]]) -> CallConfirmation? {
        guard let notificationCenter = snapshots.first(where: {
            let process = $0["process"] as? [String: Any]
            return process?["bundleIdentifier"] as? String == "com.apple.notificationcenterui"
        }) else { return nil }
        let roots = flatten(notificationCenter).filter {
            ($0["AXIdentifier"] as? String) == "FACETIME_NOTIFICATION" ||
            ($0["AXDescription"] as? String) == "FACETIME_NOTIFICATION"
        }
        let strings = roots.flatMap(flatten).flatMap { node in
            [node["AXTitle"], node["AXDescription"], node["AXValue"]].compactMap { $0 as? String }.map(cleanAXText)
        }
        guard let description = strings.first(where: { $0.localizedCaseInsensitiveContains(", Click to Call") }),
              let range = description.lowercased().range(of: ", click to call") else { return nil }
        let identity = String(description[..<range.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
        return identity.isEmpty ? nil : CallConfirmation(identity: identity)
    }
}

final class CallStateTracker {
    private(set) var callID: String?
    private(set) var phase = "idle"
    private(set) var observation = CallObservation()
    private var nextID = 1
    private var previousDuration: Int?
    private var missingCount = 0
    private var emittedUnverifiedTimer = false
    private var localHangupRequested = false

    var statusJSON: [String: Any] {
        [
            "phase": phase,
            "callId": callID ?? NSNull(),
            "direction": observation.direction ?? NSNull(),
            "identity": observation.identity ?? NSNull(),
            "media": observation.media ?? NSNull(),
            "durationSeconds": observation.durationSeconds ?? NSNull(),
            "verified": phase == "connected" && previousDuration != nil
        ]
    }

    func update(_ next: CallObservation) -> [[String: Any]] {
        var events: [[String: Any]] = []

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
            observation = merge(next, over: observation)
            if let failure = next.failureReason {
                let event = callEvent("call.failed", verified: true, evidence: failure)
                reset()
                return [event]
            }

            if next.hasAnswer || next.hasDecline {
                if phase != "incoming" {
                    phase = "incoming"
                    events.append(callEvent("call.incoming", verified: next.identity != nil, evidence: "answer_decline_controls"))
                }
            } else if let duration = next.durationSeconds {
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
        if phase == "starting" { return events }
        missingCount += 1
        if next.participantLeft || missingCount >= 2 {
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

    func beginOutgoingRequest(identity: String) -> String? {
        guard callID == nil else { return nil }
        callID = "local-\(nextID)"
        nextID += 1
        phase = "starting"
        observation = CallObservation(present: false, direction: "outgoing", identity: identity, media: "audio")
        previousDuration = nil
        missingCount = 0
        emittedUnverifiedTimer = false
        localHangupRequested = false
        return callID
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
        [
            "type": "event",
            "event": name,
            "callId": callID ?? NSNull(),
            "direction": observation.direction ?? NSNull(),
            "identity": observation.identity ?? NSNull(),
            "media": observation.media ?? NSNull(),
            "durationSeconds": observation.durationSeconds ?? NSNull(),
            "verified": verified,
            "evidence": evidence
        ]
    }

    private func reset() {
        callID = nil
        phase = "idle"
        observation = CallObservation()
        previousDuration = nil
        missingCount = 0
        emittedUnverifiedTimer = false
        localHangupRequested = false
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

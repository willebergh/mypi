import Foundation

// Service state is owned by main. Call IDs are local to this UUID; snapshot.seq
// is the watermark for event records already reflected in that snapshot.
struct ServiceMetadata {
    let serviceInstanceId = UUID().uuidString
    private(set) var sequence: UInt64 = 0

    func envelope(_ object: [String: Any]) -> [String: Any] {
        var result = object
        result["protocolVersion"] = 1
        result["serviceInstanceId"] = serviceInstanceId
        return result
    }

    mutating func event(_ object: [String: Any], allowedCallers: [String]) -> [String: Any] {
        var result = envelope(object)
        if result["type"] as? String == "event" {
            sequence += 1
            result["seq"] = sequence
            if result["timestamp"] == nil { result["timestamp"] = timestamp() }
            if result["event"] as? String == "call.incoming" {
                result["allowed"] = callerIsAllowed(result["identity"] as? String, allowedCallers: allowedCallers)
            }
        }
        return result
    }

    func snapshot(_ object: [String: Any], allowedCallers: [String]) -> [String: Any] {
        var result = envelope(object)
        result["seq"] = sequence
        if var call = result["call"] as? [String: Any], call["phase"] as? String == "incoming" {
            call["allowed"] = callerIsAllowed(call["identity"] as? String, allowedCallers: allowedCallers)
            result["call"] = call
        }
        return result
    }
}

func callerIsAllowed(_ identity: String?, allowedCallers: [String]) -> Bool {
    guard let identity else { return false }
    let wanted = normalizedIdentity(identity)
    guard !wanted.isEmpty else { return false }
    return allowedCallers.contains { normalizedIdentity($0) == wanted }
}

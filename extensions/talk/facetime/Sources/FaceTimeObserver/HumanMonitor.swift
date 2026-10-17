import Darwin
import Foundation

func runHumanMonitor(socketPath: String, verbose: Bool = false) throws -> Never {
    let path = NSString(string: socketPath).expandingTildeInPath
    let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw monitorPOSIXError("socket") }

    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8CString)
    guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
        Darwin.close(fd)
        throw NSError(domain: "FaceTimeObserver", code: 10, userInfo: [NSLocalizedDescriptionKey: "Socket path is too long: \(path)"])
    }
    withUnsafeMutablePointer(to: &address.sun_path) { pointer in
        pointer.withMemoryRebound(to: CChar.self, capacity: bytes.count) { destination in
            bytes.withUnsafeBufferPointer { source in
                _ = memcpy(destination, source.baseAddress!, bytes.count)
            }
        }
    }
    let result = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    guard result == 0 else {
        let error = monitorPOSIXError("connect")
        Darwin.close(fd)
        throw error
    }

    print("FaceTime monitor connected. Waiting for calls…")
    print("Press Ctrl-C to stop.\n")

    var pending = Data()
    var buffer = [UInt8](repeating: 0, count: 16_384)
    while true {
        let count = Darwin.read(fd, &buffer, buffer.count)
        if count == 0 {
            Darwin.close(fd)
            throw NSError(domain: "FaceTimeObserver", code: 11, userInfo: [NSLocalizedDescriptionKey: "Observer disconnected"])
        }
        if count < 0 {
            if errno == EINTR { continue }
            let error = monitorPOSIXError("read")
            Darwin.close(fd)
            throw error
        }
        pending.append(contentsOf: buffer[0..<count])
        while let newline = pending.firstIndex(of: 0x0a) {
            let line = pending[..<newline]
            pending.removeSubrange(...newline)
            guard !line.isEmpty,
                  let object = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] else {
                continue
            }
            printHumanEvent(object, verbose: verbose)
        }
    }
}

private func printHumanEvent(_ object: [String: Any], verbose: Bool) {
    let type = object["type"] as? String ?? "unknown"
    if type == "snapshot" {
        if let call = object["call"] as? [String: Any], let phase = call["phase"] as? String, phase != "idle" {
            let identity = call["identity"] is NSNull ? "unknown caller" : String(describing: call["identity"] ?? "unknown caller")
            print("CURRENT CALL: \(phase.uppercased()) — \(identity)\n")
        } else {
            print("READY\n")
        }
        if verbose {
            let processes = object["processes"] as? [[String: Any]] ?? []
            for snapshot in processes { printProcessSummary(snapshot) }
            print("")
        }
        return
    }

    if type == "event" {
        let time = shortTime(object["timestamp"] as? String)
        let event = object["event"] as? String ?? "event"
        if event.hasPrefix("call.") {
            printCallEvent(object, time: time)
            fflush(stdout)
            return
        }
        guard verbose else { return }
        switch event {
        case "accessibility.changed":
            let process = object["process"] as? [String: Any] ?? [:]
            let element = object["element"] as? [String: Any] ?? [:]
            let notification = compactAXName(object["notification"] as? String ?? "changed")
            print("\(time)  \(processLabel(process))  \(notification)")
            printElement(element, indent: "    ")
        case "accessibility.reconciled":
            let process = object["process"] as? [String: Any] ?? [:]
            let snapshot = object["snapshot"] as? [String: Any] ?? [:]
            print("\(time)  \(processLabel(process))  UI tree changed (\(snapshot["nodeCount"] ?? "?") nodes)")
            if let tree = snapshot["tree"] as? [String: Any] {
                let useful = collectUsefulElements(tree, limit: 12)
                for element in useful { printElement(element, indent: "    ") }
            }
        case "process.started", "process.stopped", "bridge.status":
            let process = object["process"] as? [String: Any]
            print("\(time)  \(event)\(process.map { " — \(processLabel($0))" } ?? "")")
        default:
            print("\(time)  \(event)")
        }
        fflush(stdout)
        return
    }

    if type == "diagnostic" && verbose {
        print("DIAGNOSTIC [\(object["level"] ?? "info")]: \(object["message"] ?? object)")
    } else if type == "response" && verbose {
        print("RESPONSE \(object["id"] ?? ""): \((object["ok"] as? Bool) == true ? "OK" : "FAILED")")
    }
}

private func printCallEvent(_ object: [String: Any], time: String) {
    let event = object["event"] as? String ?? "call.event"
    let identity = object["identity"] is NSNull ? nil : object["identity"] as? String
    let media = object["media"] is NSNull ? nil : object["media"] as? String
    let direction = object["direction"] is NSNull ? nil : object["direction"] as? String
    let verified = (object["verified"] as? Bool) == true

    let label: String
    switch event {
    case "call.incoming": label = "INCOMING"
    case "call.dialing": label = "CALLING"
    case "call.unknown": label = "CONNECTING"
    case "call.connected": label = "CONNECTED"
    case "call.ended": label = "ENDED"
    case "call.failed": label = "FAILED"
    case "call.answer_attempted": label = "ANSWERING"
    case "call.confirmation_attempted": label = "CONFIRMING CALL"
    default: label = event.uppercased()
    }

    var details: [String] = []
    if let identity { details.append(identity) }
    if let media { details.append(media) }
    if identity == nil, let direction { details.append(direction) }
    if event == "call.connected" && verified { details.append("verified") }
    if event == "call.ended", let evidence = object["evidence"] as? String {
        details.append(evidence.replacingOccurrences(of: "_", with: " "))
    }
    print("\(time)  \(label)\(details.isEmpty ? "" : " — \(details.joined(separator: ", "))")")
}

private func printProcessSummary(_ snapshot: [String: Any]) {
    let process = snapshot["process"] as? [String: Any] ?? [:]
    let nodes = snapshot["nodeCount"] ?? 0
    let truncated = (snapshot["truncated"] as? Bool) == true ? ", truncated" : ""
    print("  • \(processLabel(process)): \(nodes) AX nodes\(truncated)")
    if snapshot["error"] != nil { print("    Error: \(snapshot["error"]!)") }
}

private func printElement(_ element: [String: Any], indent: String) {
    var primary: [String] = []
    for key in ["AXRole", "AXSubrole"] {
        if let value = displayValue(element[key]) { primary.append(compactAXName(value)) }
    }
    var details: [String] = []
    for (label, key) in [("title", "AXTitle"), ("description", "AXDescription"), ("value", "AXValue"), ("id", "AXIdentifier")] {
        if let value = displayValue(element[key]), !value.isEmpty { details.append("\(label)=\"\(value)\"") }
    }
    if let actions = element["actions"] as? [String], !actions.isEmpty {
        details.append("actions=[\(actions.map(compactAXName).joined(separator: ", "))]")
    }
    let text = (primary + details).joined(separator: "  ")
    print(indent + (text.isEmpty ? "(element details unavailable)" : text))
}

private func collectUsefulElements(_ root: [String: Any], limit: Int) -> [[String: Any]] {
    var result: [[String: Any]] = []
    func visit(_ node: [String: Any]) {
        guard result.count < limit else { return }
        let role = node["AXRole"] as? String ?? ""
        let hasText = ["AXTitle", "AXDescription", "AXValue", "AXIdentifier"].contains { displayValue(node[$0]) != nil }
        let hasAction = !(node["actions"] as? [String] ?? []).isEmpty
        let usefulRole = ["Button", "StaticText", "TextField", "Window", "Sheet", "Group"].contains { role.contains($0) }
        if (hasText || hasAction) && usefulRole { result.append(node) }
        for child in node["children"] as? [[String: Any]] ?? [] { visit(child) }
    }
    visit(root)
    return result
}

private func processLabel(_ process: [String: Any]) -> String {
    let name = process["name"] as? String ?? "unknown process"
    return "\(name)[\(process["pid"] ?? "?")]"
}

private func shortTime(_ timestamp: String?) -> String {
    guard let timestamp, let separator = timestamp.firstIndex(of: "T") else { return "--:--:--" }
    return String(timestamp[timestamp.index(after: separator)...].prefix(8))
}

private func compactAXName(_ value: String) -> String {
    value.hasPrefix("AX") ? String(value.dropFirst(2)) : value
}

private func displayValue(_ value: Any?) -> String? {
    guard let value, !(value is NSNull) else { return nil }
    if let string = value as? String { return string }
    if let number = value as? NSNumber { return number.stringValue }
    return nil
}

private func monitorPOSIXError(_ operation: String) -> Error {
    NSError(domain: NSPOSIXErrorDomain, code: Int(errno), userInfo: [NSLocalizedDescriptionKey: "\(operation): \(String(cString: strerror(errno)))"])
}

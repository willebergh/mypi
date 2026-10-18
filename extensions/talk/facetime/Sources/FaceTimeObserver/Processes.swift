import AppKit
import Foundation

struct ProcessTarget: Hashable {
    let pid: pid_t
    let name: String
    let bundleIdentifier: String?

    var json: [String: Any] {
        [
            "pid": Int(pid),
            "name": name,
            "bundleIdentifier": bundleIdentifier ?? NSNull()
        ]
    }
}

struct TargetFilter {
    var pids: Set<pid_t> = []
    var bundleIDs: [String] = []
    var processTerms: [String] = []

    var isExplicit: Bool { !pids.isEmpty || !bundleIDs.isEmpty || !processTerms.isEmpty }

    func matches(_ app: NSRunningApplication) -> Bool {
        if pids.contains(app.processIdentifier) { return true }
        let bundle = app.bundleIdentifier ?? ""
        let name = app.localizedName ?? ""
        if bundleIDs.contains(where: { bundle.localizedCaseInsensitiveContains($0) }) { return true }
        if processTerms.contains(where: {
            name.localizedCaseInsensitiveContains($0) || bundle.localizedCaseInsensitiveContains($0)
        }) { return true }
        if isExplicit { return false }

        // These are discovery candidates, not assumptions about which process owns call UI.
        let haystack = "\(name) \(bundle)".lowercased()
        return ["facetime", "notificationcenter", "notification center", "call", "avconferenced", "com.apple.screencaptureui", "com.apple.controlcenter"]
            .contains(where: haystack.contains)
    }
}

func runningTargets(filter: TargetFilter) -> [ProcessTarget] {
    NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy != .prohibited || filter.matches($0) }
        .filter(filter.matches)
        .map {
            ProcessTarget(
                pid: $0.processIdentifier,
                name: $0.localizedName ?? "pid-\($0.processIdentifier)",
                bundleIdentifier: $0.bundleIdentifier
            )
        }
        .sorted { $0.pid < $1.pid }
}

func allInterestingProcesses() -> [[String: Any]] {
    let apps = NSWorkspace.shared.runningApplications.map { app in
        ProcessTarget(
            pid: app.processIdentifier,
            name: app.localizedName ?? "pid-\(app.processIdentifier)",
            bundleIdentifier: app.bundleIdentifier
        )
    }
    let terms = ["facetime", "notification", "call", "avconference", "com.apple.screencaptureui", "com.apple.controlcenter"]
    return apps.filter { target in
        let value = "\(target.name) \(target.bundleIdentifier ?? "")".lowercased()
        return terms.contains(where: value.contains)
    }.sorted { $0.pid < $1.pid }.map(\.json)
}

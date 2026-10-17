import Foundation

struct ConfigurationReloadError: LocalizedError {
    let code: String
    let message: String
    var errorDescription: String? { message }
}

func validateConfigReloadCommand(_ command: [String: Any]) throws {
    guard Set(command.keys).isSubset(of: ["type", "command", "id"]) else {
        throw ConfigurationReloadError(code: "invalid_command", message: "config.reload accepts no parameters; it reloads only the service's current configPath")
    }
}

// Transaction boundary shared by the real service and synthetic tests. Guard
// before reading the file or touching routing. The caller commits the returned
// copy only on success, preserving its known policy/options on any failure.
func reloadedTalkOptions(current: Options, phase: String, hasPendingOutgoing: Bool,
                         hasTrackedCall: Bool = false,
                         load: (String) throws -> DaemonConfiguration = DaemonConfiguration.load,
                         applyRouting: (String, String) throws -> Void) throws -> Options {
    guard phase == "idle", !hasTrackedCall, !hasPendingOutgoing else {
        throw ConfigurationReloadError(code: "call_in_progress", message: "Config can only be reloaded while tracked idle with no pending outgoing request")
    }
    let configuration = try load(current.configPath)
    var candidate = current
    candidate.applyConfiguration(configuration)
    if let input = candidate.inputDevice, let output = candidate.outputDevice {
        try applyRouting(input, output)
    }
    return candidate
}

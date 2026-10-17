import XCTest
@testable import FaceTimeObserver

// No NSApplication, menus, workspace operations, permission APIs, or WatchService
// startup: all app policy dependencies below are synthetic.
final class ApplicationTests: XCTestCase {
    func testOnlyNoArgumentBridgeBundleUsesApplicationDefault() {
        func entry(_ arguments: [String] = ["/Applications/Pi FaceTime Bridge.app/Contents/MacOS/facetime-observer"],
                   id: String? = "dev.mypi.facetime-bridge",
                   path: String = "/Applications/Pi FaceTime Bridge.app",
                   executable: String? = "facetime-observer") -> Bool {
            usesBridgeApplicationEntry(arguments: arguments, bundleIdentifier: id, bundlePath: path, bundleExecutable: executable)
        }
        XCTAssertTrue(entry())
        // Installation path and app filename are not identity requirements.
        XCTAssertTrue(entry(path: "/tmp/Renamed.app"))
        XCTAssertFalse(entry(id: nil))
        XCTAssertFalse(entry(id: "com.apple.FaceTime"))
        XCTAssertFalse(entry(path: "/usr/local/bin"))
        XCTAssertFalse(entry(path: "/Applications/Pi FaceTime Bridge.app/Contents/MacOS"))
        XCTAssertFalse(entry(executable: nil))
        XCTAssertFalse(entry(executable: "other-helper"))
        XCTAssertFalse(entry([]))
        for arguments in [["binary", "watch"], ["binary", "permission", "--prompt"],
                          ["binary", "--help"], ["binary", "--config", "/tmp/config.json"],
                          ["binary", "unknown"], ["binary", "app"]] {
            XCTAssertFalse(entry(arguments), "Explicit arguments must not take the bundle default: \(arguments)")
        }
    }

    func testCLICommandDefaultsAndExplicitAppParsing() {
        let config = "/tmp/missing-\(UUID().uuidString).json"
        XCTAssertEqual(Options(arguments: ["binary", "--config", config]).command, "help")
        for command in ["permission", "discover", "dump", "snapshot", "watch", "serve", "monitor", "app"] {
            let options = Options(arguments: ["binary", command, "--config", config])
            XCTAssertEqual(options.command, command)
        }
        XCTAssertEqual(Options(arguments: ["binary", "app", "--config", config, "--help"]).command, "help")
    }

    func testUntrustedLaunchDoesNotPromptOrCreateServiceAndGrantDoesNotAutoStart() {
        var trusted = false
        var prompts = 0
        var creations = 0
        let service = FakeBridgeService()
        let controller = BridgeApplicationController(
            loadOptions: { self.options() },
            isTrusted: { trusted },
            promptForPermission: { prompts += 1 },
            makeService: { _ in creations += 1; return service }
        )
        controller.start() // Same action used by applicationDidFinishLaunching.
        XCTAssertEqual(controller.status, .permissionNeeded)
        XCTAssertNotNil(controller.status.message)
        XCTAssertEqual(prompts, 0)
        XCTAssertEqual(creations, 0)
        controller.refreshPermission()
        XCTAssertEqual(prompts, 0)
        controller.requestPermission()
        XCTAssertEqual(prompts, 1)
        XCTAssertEqual(creations, 0)
        trusted = true
        controller.refreshPermission()
        XCTAssertEqual(controller.status, .stopped)
        XCTAssertEqual(creations, 0)
        controller.start()
        XCTAssertEqual(controller.status, .running)
        XCTAssertEqual(creations, 1)
        XCTAssertEqual(service.starts, 1)
    }

    func testTrustedLaunchPassesConfigurationAndStopRestartIsExplicit() {
        var options = options()
        options.allowedCallers = ["synthetic caller"]
        options.allowedRecipients = ["synthetic recipient"]
        options.recipientAliases = ["synthetic recipient": ["alias"]]
        options.autoAnswer = true
        options.socketPath = "/tmp/synthetic-control.sock"
        options.prompt = true // App controller must not act on CLI --prompt.
        let service = FakeBridgeService()
        var prompts = 0
        var creations = 0
        let controller = BridgeApplicationController(
            loadOptions: { options },
            isTrusted: { true },
            promptForPermission: { prompts += 1 },
            makeService: { received in
                creations += 1
                XCTAssertEqual(received.allowedCallers, options.allowedCallers)
                XCTAssertEqual(received.allowedRecipients, options.allowedRecipients)
                XCTAssertEqual(received.recipientAliases, options.recipientAliases)
                XCTAssertEqual(received.socketPath, options.socketPath)
                XCTAssertTrue(received.autoAnswer)
                return service
            }
        )
        controller.start()
        controller.start()
        XCTAssertEqual(controller.status, .running)
        XCTAssertEqual(service.starts, 1)
        XCTAssertEqual(prompts, 0)
        controller.stop()
        controller.stop()
        XCTAssertEqual(controller.status, .stopped)
        XCTAssertEqual(service.stops, 1)
        controller.refreshPermission()
        XCTAssertEqual(creations, 1)
        controller.start()
        XCTAssertEqual(service.starts, 2)
        controller.stop()
        XCTAssertEqual(service.stops, 2)
    }

    func testConfigErrorIsVisibleAndRetryReloadsConfiguration() {
        var options = options()
        options.configError = "Config must be accessible only to the current user (run chmod 600 config.json)"
        let service = FakeBridgeService()
        var loads = 0
        var creations = 0
        let controller = BridgeApplicationController(
            loadOptions: { loads += 1; return options },
            isTrusted: { true },
            promptForPermission: { XCTFail("Must not prompt") },
            makeService: { _ in creations += 1; return service }
        )
        controller.start()
        guard case .startupError(let message) = controller.status else { return XCTFail("Expected visible config error") }
        XCTAssertTrue(message.contains(options.configPath))
        XCTAssertTrue(message.contains("chmod 600"))
        XCTAssertTrue(message.contains("Retry"))
        XCTAssertEqual(creations, 0)
        options.configError = nil
        controller.start()
        XCTAssertEqual(loads, 2)
        XCTAssertEqual(controller.status, .running)
        controller.stop()
    }

    func testStartupErrorCleansCandidateAndDoesNotRetryUntilUserAction() {
        let failed = FakeBridgeService()
        failed.error = NSError(domain: "synthetic", code: 1, userInfo: [NSLocalizedDescriptionKey: "Socket lock held"])
        let healthy = FakeBridgeService()
        var attempts = 0
        let controller = BridgeApplicationController(
            loadOptions: { self.options() },
            isTrusted: { true },
            promptForPermission: { XCTFail("Must not prompt") },
            makeService: { _ in
                attempts += 1
                return attempts == 1 ? failed : healthy
            }
        )
        controller.start()
        XCTAssertEqual(failed.stops, 1)
        guard case .startupError(let message) = controller.status else { return XCTFail("Expected startup error") }
        XCTAssertTrue(message.contains("Socket lock held"))
        XCTAssertTrue(message.contains("Retry"))
        controller.refreshPermission()
        XCTAssertEqual(attempts, 1)
        controller.start()
        XCTAssertEqual(controller.status, .running)
        XCTAssertEqual(attempts, 2)
        controller.stop()
        XCTAssertEqual(healthy.stops, 1)
    }

    func testChosenFileAppliesOnlyOnNextStopStartAndExplicitConfigWins() throws {
        let first = try TemporaryTalkConfig()
        let second = try TemporaryTalkConfig()
        try first.write()
        var secondObject = try SharedConfigFixture.object()
        var policy = secondObject["facetime"] as! [String: Any]
        policy["allowedCallers"] = ["Second caller"]
        secondObject["facetime"] = policy
        try second.writeObject(secondObject)
        var chosen: String? = first.path
        var received: [Options] = []
        var loads = 0
        let service = FakeBridgeService()
        let controller = BridgeApplicationController(
            loadOptions: {
                loads += 1
                return Options(arguments: ["binary", "app"], persistedConfigPath: chosen, environment: [:])
            }, isTrusted: { true }, promptForPermission: { XCTFail("Must not prompt") },
            makeService: { received.append($0); return service }
        )
        controller.start()
        XCTAssertEqual(received.last?.configPath, first.path)
        XCTAssertEqual(received.last?.inputDevice, "Pi virtual speaker")
        XCTAssertFalse(received.last!.autoAnswer)
        chosen = second.path // Equivalent to the picker persisting a new path.
        controller.start() // Running means no reload or live routing.
        XCTAssertEqual(loads, 1)
        XCTAssertEqual(received.count, 1)
        controller.stop()
        controller.start()
        XCTAssertEqual(loads, 2)
        XCTAssertEqual(received.last?.configPath, second.path)
        XCTAssertEqual(received.last?.allowedCallers, ["Second caller"])
        controller.stop()
        let explicit = Options(arguments: ["binary", "app", "--config", first.path], persistedConfigPath: chosen)
        XCTAssertEqual(explicit.configPath, first.path)
        XCTAssertEqual(explicit.allowedCallers, ["Caller"])
    }

    func testLegacyConfigErrorCanBeFixedByChoosingSharedFileThenRetrying() throws {
        let legacy = try TemporaryTalkConfig()
        let shared = try TemporaryTalkConfig()
        try legacy.write(#"{"allowedCallers":["Old"],"autoAnswer":true}"#)
        try shared.write()
        var chosen = legacy.path
        var received: Options?
        let controller = BridgeApplicationController(
            loadOptions: { Options(arguments: ["binary", "app"], persistedConfigPath: chosen) },
            isTrusted: { true }, promptForPermission: { XCTFail("Must not prompt") },
            makeService: { received = $0; return FakeBridgeService() }
        )
        controller.start()
        guard case .startupError(let message) = controller.status else { return XCTFail("Expected old-file action error") }
        XCTAssertTrue(message.contains(legacy.path))
        XCTAssertTrue(message.contains("migrate"))
        XCTAssertTrue(message.contains("Retry"))
        XCTAssertNil(received)
        chosen = shared.path
        controller.start()
        XCTAssertEqual(controller.status, .running)
        XCTAssertEqual(received?.configPath, shared.path)
        XCTAssertEqual(received?.allowedCallers, ["Caller"])
        controller.stop()
    }

    private func options() -> Options {
        Options(arguments: ["binary", "app", "--config", "/tmp/missing-\(UUID().uuidString).json"])
    }
}

private final class FakeBridgeService: BridgeService {
    var starts = 0
    var stops = 0
    var error: Error?

    func start() throws {
        starts += 1
        if let error { throw error }
    }
    func stop() { stops += 1 }
}

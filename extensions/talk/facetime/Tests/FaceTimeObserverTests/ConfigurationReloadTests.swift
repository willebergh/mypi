import XCTest
@testable import FaceTimeObserver

final class ConfigurationReloadTests: XCTestCase {
    func testReloadRejectsAllParametersIncludingPaths() throws {
        let command: [String: Any] = ["type": "command", "command": "config.reload", "id": "reload"]
        XCTAssertNoThrow(try validateConfigReloadCommand(command))
        for key in ["path", "config", "configPath", "input", "output", "to", "parameters"] {
            var invalid = command
            invalid[key] = "/arbitrary/file.json"
            XCTAssertThrowsError(try validateConfigReloadCommand(invalid)) { error in
                XCTAssertEqual((error as? ConfigurationReloadError)?.code, "invalid_command")
            }
        }
    }

    func testActiveCallOrPendingLaunchRejectsBeforeLoadingOrRouting() throws {
        let file = try TemporaryTalkConfig()
        try file.write()
        let options = Options(arguments: ["binary", "watch", "--config", file.path])
        for (phase, pending) in [("incoming", false), ("starting", false), ("dialing", false),
                                 ("connected", false), ("unknown", false), ("idle", true)] {
            XCTAssertThrowsError(try reloadedTalkOptions(current: options, phase: phase, hasPendingOutgoing: pending,
                load: { _ in XCTFail("Guard must run before reading the file"); return DaemonConfiguration() },
                applyRouting: { _, _ in XCTFail("Guard must run before routing") })) { error in
                    XCTAssertEqual((error as? ConfigurationReloadError)?.code, "call_in_progress")
                }
        }
        XCTAssertEqual(options.allowedCallers, ["Caller"])
    }

    func testFirstUnverifiedDurationIsAKnownCallEvenWhilePhaseStillIdle() throws {
        let file = try TemporaryTalkConfig()
        try file.write()
        let current = Options(arguments: ["binary", "watch", "--config", file.path])
        let tracker = CallStateTracker()
        _ = tracker.update(CallObservation(present: true, durationSeconds: 1))
        XCTAssertEqual(tracker.phase, "idle")
        XCTAssertNotNil(tracker.callID)
        XCTAssertThrowsError(try reloadedTalkOptions(current: current, phase: tracker.phase, hasPendingOutgoing: false,
            hasTrackedCall: tracker.callID != nil,
            load: { _ in XCTFail("Known call must block loading"); return DaemonConfiguration() },
            applyRouting: { _, _ in XCTFail("Known call must block routing") })) { error in
                XCTAssertEqual((error as? ConfigurationReloadError)?.code, "call_in_progress")
            }
    }

    func testReloadCommitsCoherentPolicyAndVerifiedInverseRouteFromCurrentFile() throws {
        let file = try TemporaryTalkConfig()
        try file.write()
        var current = Options(arguments: ["binary", "watch", "--config", file.path])
        var object = try SharedConfigFixture.object()
        object["facetime"] = ["allowedCallers": ["New caller"], "allowedRecipients": ["New recipient"],
                              "recipientAliases": ["New recipient": ["New alias"]],
                              "callStartTimeoutSeconds": 30, "ringingTimeoutSeconds": 120]
        object["audio"] = ["physical": [:], "virtual": ["microphone": ["id": "new-mic", "name": "New mic"],
                                                        "speaker": ["id": "new-speaker", "name": "New speaker"]]]
        try file.writeObject(object)
        var routes: [[String]] = []
        let candidate = try reloadedTalkOptions(current: current, phase: "idle", hasPendingOutgoing: false,
            load: { path in
                XCTAssertEqual(path, current.configPath)
                return try DaemonConfiguration.load(path: path)
            }, applyRouting: { input, output in
                routes.append([input, output])
                // Effective policy remains unchanged until the caller commits.
                XCTAssertEqual(current.allowedCallers, ["Caller"])
                XCTAssertEqual(current.inputDevice, "Pi virtual speaker")
            })
        current = candidate
        XCTAssertEqual(routes, [["New speaker", "New mic"]])
        XCTAssertEqual(current.allowedCallers, ["New caller"])
        XCTAssertEqual(current.allowedRecipients, ["New recipient"])
        XCTAssertEqual(current.recipientAliases, ["New recipient": ["New alias"]])
        XCTAssertEqual(current.callStartTimeoutSeconds, 30)
        XCTAssertEqual(current.ringingTimeoutSeconds, 120)
        XCTAssertFalse(current.autoAnswer)
        XCTAssertEqual(current.configPath, file.path)
        XCTAssertEqual(current.configurationJSON["configPath"] as? String, file.path)
        let metadata = ServiceMetadata()
        let snapshot = metadata.snapshot(["type": "snapshot", "configuration": current.configurationJSON], allowedCallers: current.allowedCallers)
        XCTAssertEqual(snapshot["serviceInstanceId"] as? String, metadata.serviceInstanceId)
        XCTAssertEqual(snapshot["seq"] as? UInt64, 0)
        XCTAssertEqual((snapshot["configuration"] as? [String: Any])?["configPath"] as? String, file.path)
    }

    func testFailedReadAndRoutingPreserveKnownOptionsUntilSuccessfulRetry() throws {
        let file = try TemporaryTalkConfig()
        try file.write()
        var current = Options(arguments: ["binary", "watch", "--config", file.path])
        try file.write(#"{"version":2}"#)
        XCTAssertThrowsError(try reloadedTalkOptions(current: current, phase: "idle", hasPendingOutgoing: false,
            applyRouting: { _, _ in XCTFail("Bad files must not route") }))
        XCTAssertEqual(current.allowedCallers, ["Caller"])
        XCTAssertEqual(current.allowedRecipients, ["Recipient"])
        XCTAssertEqual(current.inputDevice, "Pi virtual speaker")
        XCTAssertNil(current.configError)
        var object = try SharedConfigFixture.object()
        var policy = object["facetime"] as! [String: Any]
        policy["allowedCallers"] = ["Changed"]
        object["facetime"] = policy
        try file.writeObject(object)
        XCTAssertThrowsError(try reloadedTalkOptions(current: current, phase: "idle", hasPendingOutgoing: false,
            applyRouting: { _, _ in throw ConfigurationReloadError(code: "audio_routing_failed", message: "Synthetic verification failure") }))
        XCTAssertEqual(current.allowedCallers, ["Caller"])
        XCTAssertEqual(current.recipientAliases, ["Recipient": ["Recipient alias"]])
        current = try reloadedTalkOptions(current: current, phase: "idle", hasPendingOutgoing: false, applyRouting: { _, _ in })
        XCTAssertEqual(current.allowedCallers, ["Changed"])
    }

    func testPartialOrUnsetVirtualRouteDoesNotApplyAnyRoutingOrPhysicalDefaults() throws {
        let file = try TemporaryTalkConfig()
        try file.write()
        let current = Options(arguments: ["binary", "watch", "--config", file.path])
        for virtual: [String: Any] in [[:], ["microphone": ["id": "mic", "name": "Virtual mic"]],
                                       ["speaker": ["id": "speaker", "name": "Virtual speaker"]]] {
            var object = try SharedConfigFixture.object()
            var audio = object["audio"] as! [String: Any]
            audio["virtual"] = virtual
            object["audio"] = audio
            try file.writeObject(object)
            let candidate = try reloadedTalkOptions(current: current, phase: "idle", hasPendingOutgoing: false,
                applyRouting: { _, _ in XCTFail("Both explicit virtual endpoints are required") })
            XCTAssertEqual(candidate.allowedCallers, ["Caller"])
            XCTAssertEqual(candidate.inputDevice, (virtual["speaker"] as? [String: String])?["name"])
            XCTAssertEqual(candidate.outputDevice, (virtual["microphone"] as? [String: String])?["name"])
        }
    }

    func testMissingFileClearsPolicyButEmptyFileErrorsWithoutRouting() throws {
        let file = try TemporaryTalkConfig()
        try file.write()
        let current = Options(arguments: ["binary", "watch", "--config", file.path])
        try FileManager.default.removeItem(atPath: file.path)
        let candidate = try reloadedTalkOptions(current: current, phase: "idle", hasPendingOutgoing: false,
            applyRouting: { _, _ in XCTFail("No routes configured") })
        XCTAssertTrue(candidate.allowedCallers.isEmpty)
        XCTAssertTrue(candidate.allowedRecipients.isEmpty)
        XCTAssertTrue(candidate.recipientAliases.isEmpty)
        XCTAssertNil(candidate.inputDevice)
        XCTAssertNil(candidate.outputDevice)
        XCTAssertEqual(candidate.configPath, file.path)
        try file.write("")
        XCTAssertThrowsError(try reloadedTalkOptions(current: current, phase: "idle", hasPendingOutgoing: false,
            applyRouting: { _, _ in XCTFail("Invalid config must not route") }))
        XCTAssertEqual(current.allowedCallers, ["Caller"])
    }

    func testOnlyExplicitCLIAutoAnswerOverrideSurvivesReload() throws {
        let file = try TemporaryTalkConfig()
        try file.write()
        let options = Options(arguments: ["binary", "watch", "--config", file.path, "--auto-answer"])
        XCTAssertTrue(options.autoAnswer)
        let candidate = try reloadedTalkOptions(current: options, phase: "idle", hasPendingOutgoing: false, applyRouting: { _, _ in })
        XCTAssertTrue(candidate.autoAnswer)
        XCTAssertFalse(try DaemonConfiguration.load(path: file.path).autoAnswer)
    }

    func testRoutingVerificationRequiresBothUniqueSelectedDevices() {
        func device(_ section: String, _ name: String, selected: Bool = true) -> FaceTimeAudioDevice {
            FaceTimeAudioDevice(section: section, name: name, identifier: nil, selected: selected, enabled: true)
        }
        let devices = [device("input", "Pi virtual speaker"), device("output", "Pi virtual microphone")]
        XCTAssertNil(faceTimeAudioRoutingVerificationError(input: "Pi virtual speaker", output: "Pi virtual microphone", devices: devices))
        XCTAssertNotNil(faceTimeAudioRoutingVerificationError(input: "Pi virtual microphone", output: "Pi virtual speaker", devices: devices))
        XCTAssertNotNil(faceTimeAudioRoutingVerificationError(input: "Pi virtual speaker", output: "Pi virtual microphone", devices: [devices[0]]))
        XCTAssertNotNil(faceTimeAudioRoutingVerificationError(input: "Pi virtual speaker", output: "Pi virtual microphone", devices: devices + [devices[0]]))
        XCTAssertNotNil(faceTimeAudioRoutingVerificationError(input: "Pi virtual speaker", output: "Pi virtual microphone", devices: [device("input", "Pi virtual speaker", selected: false), devices[1]]))
    }
}

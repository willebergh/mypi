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

    func testReloadCommitsCoherentPolicyAndVerifiedPiTalkRouteFromCurrentFile() throws {
        let file = try TemporaryTalkConfig()
        try file.write()
        var current = Options(arguments: ["binary", "watch", "--config", file.path])
        var object = try SharedConfigFixture.object()
        object["facetime"] = ["allowedCallers": ["New caller"], "allowedRecipients": ["New recipient"],
                              "recipientAliases": ["New recipient": ["New alias"]],
                              "callStartTimeoutSeconds": 30, "ringingTimeoutSeconds": 120]
        var audio = object["audio"] as! [String: Any]
        audio["physical"] = ["microphone": ["id": "new-mic", "name": "New physical mic"],
                             "speaker": ["id": "new-speaker", "name": "New physical speaker"]]
        object["audio"] = audio
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
                XCTAssertEqual(current.inputDevice, "Pi Talk")
                XCTAssertEqual(current.outputDevice, "Pi Talk")
            })
        current = candidate
        XCTAssertEqual(routes, [["Pi Talk", "Pi Talk"]])
        XCTAssertEqual(current.inputDevice, "Pi Talk")
        XCTAssertEqual(current.outputDevice, "Pi Talk")
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
        XCTAssertEqual(current.inputDevice, "Pi Talk")
        XCTAssertEqual(current.outputDevice, "Pi Talk")
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

    func testInvalidVirtualUIDsRejectReloadBeforeRoutingOrPolicyCommit() throws {
        let file = try TemporaryTalkConfig()
        try file.write()
        let current = Options(arguments: ["binary", "watch", "--config", file.path])
        let original = try SharedConfigFixture.object()
        let originalAudio = original["audio"] as! [String: Any]
        let virtual = originalAudio["virtual"] as! [String: String]
        var invalidRoutes: [[String: Any]] = [[:],
            ["visibleUid": virtual["visibleUid"]!], ["internalUid": virtual["internalUid"]!],
            ["microphone": ["id": "mic", "name": "Pi Talk"], "speaker": ["id": "speaker", "name": "Pi Talk"]],
            ["visibleUid": virtual["internalUid"]!, "internalUid": virtual["visibleUid"]!]]
        for key in ["visibleUid", "internalUid"] {
            var invalid: [String: Any] = virtual
            invalid[key] = virtual[key]! + " "
            invalidRoutes.append(invalid)
        }
        for invalid in invalidRoutes {
            var object = original
            var audio = originalAudio
            audio["virtual"] = invalid
            object["audio"] = audio
            var policy = object["facetime"] as! [String: Any]
            policy["allowedCallers"] = ["Must not commit"]
            object["facetime"] = policy
            try file.writeObject(object)
            XCTAssertThrowsError(try reloadedTalkOptions(current: current, phase: "idle", hasPendingOutgoing: false,
                applyRouting: { _, _ in XCTFail("Invalid virtual UIDs must not route") }))
            XCTAssertEqual(current.allowedCallers, ["Caller"])
            XCTAssertEqual(current.inputDevice, "Pi Talk")
            XCTAssertEqual(current.outputDevice, "Pi Talk")
            XCTAssertNil(current.configError)
        }
        try file.write()
        let candidate = try reloadedTalkOptions(current: current, phase: "idle", hasPendingOutgoing: false,
            applyRouting: { input, output in
                XCTAssertEqual(input, "Pi Talk")
                XCTAssertEqual(output, "Pi Talk")
            })
        XCTAssertEqual(candidate.allowedCallers, ["Caller"])
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
        func device(_ section: String, _ name: String = "Pi Talk", selected: Bool = true, enabled: Bool = true) -> FaceTimeAudioDevice {
            FaceTimeAudioDevice(section: section, name: name, identifier: nil, selected: selected, enabled: enabled)
        }
        let devices = [device("input"), device("output")]
        XCTAssertNil(faceTimeAudioRoutingVerificationError(input: "Pi Talk", output: "Pi Talk", devices: devices))
        XCTAssertNotNil(faceTimeAudioRoutingVerificationError(input: "Wrong input", output: "Pi Talk", devices: devices))
        XCTAssertNotNil(faceTimeAudioRoutingVerificationError(input: "Pi Talk", output: "Wrong output", devices: devices))
        for section in ["input", "output"] {
            XCTAssertNotNil(faceTimeAudioRoutingVerificationError(input: "Pi Talk", output: "Pi Talk", devices: devices.filter { $0.section != section }))
            XCTAssertNotNil(faceTimeAudioRoutingVerificationError(input: "Pi Talk", output: "Pi Talk", devices: devices + [device(section)]))
            let other = devices.filter { $0.section != section }
            XCTAssertNotNil(faceTimeAudioRoutingVerificationError(input: "Pi Talk", output: "Pi Talk", devices: other + [device(section, selected: false)]))
            XCTAssertNotNil(faceTimeAudioRoutingVerificationError(input: "Pi Talk", output: "Pi Talk", devices: other + [device(section, enabled: false)]))
        }
    }

    func testSoleDefaultPiTalkInputUsesExactCoreAudioUIDOnlyWhenFaceTimeOmitsSection() {
        let output = FaceTimeAudioDevice(section: "output", name: "Pi Talk", identifier: "pi_talk", selected: true, enabled: true)
        let routed = addingSoleDefaultPiTalkInput(
            to: [output], microphoneSectionPresent: false, outputSectionPresent: true,
            defaultInputUID: piTalkVisibleAudioUID)
        XCTAssertEqual(routed.count, 2)
        XCTAssertEqual(routed.last, FaceTimeAudioDevice(
            section: "input", name: "Pi Talk", identifier: faceTimeSystemDefaultInputIdentifier,
            selected: true, enabled: true))
        XCTAssertNil(faceTimeAudioRoutingVerificationError(input: "Pi Talk", output: "Pi Talk", devices: routed))

        for uid in [nil, "", "io.github.willebergh.pitalk.audio.internal", piTalkVisibleAudioUID + " "] as [String?] {
            XCTAssertEqual(addingSoleDefaultPiTalkInput(
                to: [output], microphoneSectionPresent: false, outputSectionPresent: true,
                defaultInputUID: uid), [output])
        }
        XCTAssertEqual(addingSoleDefaultPiTalkInput(
            to: [output], microphoneSectionPresent: true, outputSectionPresent: true,
            defaultInputUID: piTalkVisibleAudioUID), [output])
        XCTAssertEqual(addingSoleDefaultPiTalkInput(
            to: [], microphoneSectionPresent: false, outputSectionPresent: false,
            defaultInputUID: piTalkVisibleAudioUID), [])

        let unexpectedInput = FaceTimeAudioDevice(
            section: "input", name: "Other", identifier: "other", selected: true, enabled: true)
        XCTAssertEqual(addingSoleDefaultPiTalkInput(
            to: [unexpectedInput, output], microphoneSectionPresent: false, outputSectionPresent: true,
            defaultInputUID: piTalkVisibleAudioUID), [unexpectedInput, output])
    }
}

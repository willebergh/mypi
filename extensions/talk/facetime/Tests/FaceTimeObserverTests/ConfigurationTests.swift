import Darwin
import XCTest
@testable import FaceTimeObserver

final class ConfigurationTests: XCTestCase {
    func testLoadsSharedConfigurationWithInverseVirtualRoute() throws {
        let file = try TemporaryTalkConfig()
        try file.write()
        let config = try DaemonConfiguration.load(path: file.path)
        XCTAssertEqual(config.allowedCallers, ["Caller"])
        XCTAssertEqual(config.allowedRecipients, ["Recipient"])
        XCTAssertEqual(config.recipientAliases, ["Recipient": ["Recipient alias"]])
        XCTAssertFalse(config.autoAnswer)
        XCTAssertEqual(config.inputDevice, "Pi virtual speaker")
        XCTAssertEqual(config.outputDevice, "Pi virtual microphone")
        XCTAssertEqual(config.callStartTimeoutSeconds, 15)
        XCTAssertEqual(config.ringingTimeoutSeconds, 60)
    }

    func testMissingFileUsesSafeDefaultsButAnExistingEmptyFileIsAnError() throws {
        let file = try TemporaryTalkConfig()
        let config = try DaemonConfiguration.load(path: file.path)
        XCTAssertEqual(config, DaemonConfiguration())
        XCTAssertTrue(config.allowedCallers.isEmpty)
        XCTAssertTrue(config.allowedRecipients.isEmpty)
        XCTAssertFalse(config.autoAnswer)
        XCTAssertNil(config.inputDevice)
        XCTAssertNil(config.outputDevice)
        try file.write("")
        XCTAssertThrowsError(try DaemonConfiguration.load(path: file.path))
    }

    func testOversizedFileIsRejectedBeforeDecoding() throws {
        let file = try TemporaryTalkConfig()
        try file.write(String(repeating: " ", count: 65537))
        XCTAssertThrowsError(try DaemonConfiguration.load(path: file.path)) { error in
            XCTAssertTrue(error.localizedDescription.contains("exceeds 65536"))
        }
    }

    func testFriendlyNamesTrimWhitespaceWithoutChangingOpaqueIDs() throws {
        var object = try SharedConfigFixture.object()
        object["audio"] = ["physical": [:], "virtual": [
            "microphone": ["id": " opaque input ", "name": "  Virtual mic  "],
            "speaker": ["id": " opaque output ", "name": " Virtual speaker "]
        ]]
        let config = try SharedConfigFixture.decode(object)
        XCTAssertEqual(config.inputDevice, "Virtual speaker")
        XCTAssertEqual(config.outputDevice, "Virtual mic")
    }

    func testAbsentAndPartialVirtualEndpointsNeverFallBackToPhysical() throws {
        for virtual: [String: Any] in [[:], ["microphone": ["id": "m", "name": "Virtual mic"]],
                                       ["speaker": ["id": "s", "name": "Virtual speaker"]]] {
            var object = try SharedConfigFixture.object()
            var audio = object["audio"] as! [String: Any]
            audio["virtual"] = virtual
            object["audio"] = audio
            let config = try SharedConfigFixture.decode(object)
            XCTAssertEqual(config.inputDevice, (virtual["speaker"] as? [String: String])?["name"])
            XCTAssertEqual(config.outputDevice, (virtual["microphone"] as? [String: String])?["name"])
        }
    }

    func testRejectsUnsupportedVersionsUnknownKeysAndLegacyFields() throws {
        for version: Any in [0, 2, -1, "1", true, NSNull()] {
            var object = try SharedConfigFixture.object()
            object["version"] = version
            XCTAssertThrowsError(try SharedConfigFixture.decode(object), "version=\(version)")
        }
        var missingVersion = try SharedConfigFixture.object()
        missingVersion.removeValue(forKey: "version")
        XCTAssertThrowsError(try SharedConfigFixture.decode(missingVersion))
        for field in ["unknown", "inputDevice", "outputDevice", "autoAnswer", "allowedCallers"] {
            var root = try SharedConfigFixture.object()
            root[field] = false
            XCTAssertThrowsError(try SharedConfigFixture.decode(root), field)
            var nested = try SharedConfigFixture.object()
            var policy = nested["facetime"] as! [String: Any]
            policy[field] = false
            nested["facetime"] = policy
            XCTAssertThrowsError(try SharedConfigFixture.decode(nested), field)
        }
        let file = try TemporaryTalkConfig()
        try file.write(#"{"allowedCallers":["Legacy"],"autoAnswer":true,"inputDevice":"Old"}"#)
        XCTAssertThrowsError(try DaemonConfiguration.load(path: file.path)) { error in
            XCTAssertTrue(error.localizedDescription.contains(file.path))
            XCTAssertTrue(error.localizedDescription.contains("legacy"))
            XCTAssertTrue(error.localizedDescription.contains("migrate"))
            XCTAssertTrue(error.localizedDescription.contains("retry"))
        }
        // Missing the shared file does not consult a nearby legacy file.
        XCTAssertEqual(try DaemonConfiguration.load(path: file.directory.appendingPathComponent("missing.json").path), DaemonConfiguration())
    }

    func testExistingSharedSchemaRequiresItsSectionsAndPolicyFields() throws {
        for key in ["audio", "facetime"] {
            var object = try SharedConfigFixture.object()
            object.removeValue(forKey: key)
            XCTAssertThrowsError(try SharedConfigFixture.decode(object))
        }
        let original = try SharedConfigFixture.object()
        for key in (original["facetime"] as! [String: Any]).keys {
            var object = original
            var policy = object["facetime"] as! [String: Any]
            policy.removeValue(forKey: key)
            object["facetime"] = policy
            XCTAssertThrowsError(try SharedConfigFixture.decode(object), key)
        }
        for invalid: Any in [NSNull(), [], "settings"] {
            var object = original
            object["audio"] = invalid
            XCTAssertThrowsError(try SharedConfigFixture.decode(object))
        }
        XCTAssertThrowsError(try JSONDecoder().decode(DaemonConfiguration.self, from: Data("{}".utf8)))
    }

    func testTimeoutBoundsAndTypesAreStrict() throws {
        for key in ["callStartTimeoutSeconds", "ringingTimeoutSeconds"] {
            for value: Any in [0, -1, 0.5, 3600.1, "15", true, NSNull()] {
                var object = try SharedConfigFixture.object()
                var policy = object["facetime"] as! [String: Any]
                policy[key] = value
                object["facetime"] = policy
                XCTAssertThrowsError(try SharedConfigFixture.decode(object), "\(key)=\(value)")
            }
            for value in [1.0, 1.5, 3600.0] {
                var object = try SharedConfigFixture.object()
                var policy = object["facetime"] as! [String: Any]
                policy[key] = value
                object["facetime"] = policy
                XCTAssertNoThrow(try SharedConfigFixture.decode(object))
            }
        }
        for value in ["NaN", "Infinity", "1e999"] {
            let json = SharedConfigFixture.json.replacingOccurrences(of: "\"callStartTimeoutSeconds\": 15", with: "\"callStartTimeoutSeconds\": \(value)")
            XCTAssertThrowsError(try JSONDecoder().decode(DaemonConfiguration.self, from: Data(json.utf8)))
        }
    }

    func testPolicyListAndAliasBounds() throws {
        let long = String(repeating: "é", count: 257) // UTF-8 bytes, not characters.
        for key in ["allowedCallers", "allowedRecipients"] {
            for invalid: Any in [Array(repeating: "x", count: 129), [long], [""], [1], "Caller", ["bad\u{0085}"]] {
                var object = try SharedConfigFixture.object()
                var policy = object["facetime"] as! [String: Any]
                policy[key] = invalid
                object["facetime"] = policy
                XCTAssertThrowsError(try SharedConfigFixture.decode(object), key)
            }
            var object = try SharedConfigFixture.object()
            var policy = object["facetime"] as! [String: Any]
            policy[key] = Array(repeating: String(repeating: "é", count: 256), count: 128)
            object["facetime"] = policy
            XCTAssertNoThrow(try SharedConfigFixture.decode(object))
        }
        let many = Dictionary(uniqueKeysWithValues: (0..<129).map { ("recipient-\($0)", ["alias"]) })
        for aliases: Any in [many, [long: ["alias"]], ["Recipient": Array(repeating: "x", count: 129)], ["Recipient": [long]], ["Recipient": [1]]] {
            var object = try SharedConfigFixture.object()
            var policy = object["facetime"] as! [String: Any]
            policy["recipientAliases"] = aliases
            object["facetime"] = policy
            XCTAssertThrowsError(try SharedConfigFixture.decode(object))
        }
    }

    func testDeviceBoundsControlsAndUnknownKeysInBothProfiles() throws {
        for profile in ["physical", "virtual"] {
            for endpoint in ["microphone", "speaker"] {
                for field in ["id", "name"] {
                    let limit = field == "id" ? 512 : 256
                    for value: Any in [String(repeating: "é", count: limit / 2 + 1), "", "\n", "x\u{0000}", "x\u{007f}", "x\u{009f}", "x\u{061c}", "x\u{200e}", "x\u{202e}", "x\u{2067}", 7, NSNull()] {
                        var object = try SharedConfigFixture.object()
                        var audio = object["audio"] as! [String: Any]
                        var pair = audio[profile] as! [String: Any]
                        var device = pair[endpoint] as! [String: Any]
                        device[field] = value
                        pair[endpoint] = device
                        audio[profile] = pair
                        object["audio"] = audio
                        XCTAssertThrowsError(try SharedConfigFixture.decode(object), "\(profile).\(endpoint).\(field)=\(value)")
                    }
                }
            }
        }
        for invalid: Any in [NSNull(), ["id": "only-id"], ["name": "only-name"], ["id": "id", "name": "name", "extra": true]] {
            var object = try SharedConfigFixture.object()
            object["audio"] = ["physical": [:], "virtual": ["microphone": invalid]]
            XCTAssertThrowsError(try SharedConfigFixture.decode(object))
        }
        var object = try SharedConfigFixture.object()
        object["audio"] = ["physical": [:], "virtual": ["speaker": ["id": String(repeating: "é", count: 256), "name": String(repeating: "é", count: 128)]]]
        XCTAssertNoThrow(try SharedConfigFixture.decode(object))
    }

    func testFileMustBeRegularPrivate0600AndNotASymlink() throws {
        let file = try TemporaryTalkConfig()
        try file.write()
        for mode in [0o644, 0o640, 0o660, 0o400, 0o700, 0o1600] {
            try FileManager.default.setAttributes([.posixPermissions: mode], ofItemAtPath: file.path)
            XCTAssertThrowsError(try DaemonConfiguration.load(path: file.path), String(mode, radix: 8))
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        XCTAssertNoThrow(try DaemonConfiguration.load(path: file.path))
        let link = file.directory.appendingPathComponent("link.json").path
        try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: file.path)
        XCTAssertThrowsError(try DaemonConfiguration.load(path: link))
        try FileManager.default.removeItem(atPath: file.path)
        XCTAssertThrowsError(try DaemonConfiguration.load(path: link)) // dangling symlink
        XCTAssertThrowsError(try DaemonConfiguration.load(path: file.directory.path))
        XCTAssertEqual(mkfifo(file.path, 0o600), 0)
        XCTAssertThrowsError(try DaemonConfiguration.load(path: file.path)) // must not block
    }

    func testMalformedAndInvalidUTF8AreErrorsNotSafeDefaults() throws {
        let file = try TemporaryTalkConfig()
        for json in [" ", "{", "[]", "null"] {
            try file.write(json)
            XCTAssertThrowsError(try DaemonConfiguration.load(path: file.path))
        }
        try Data([0xff, 0xfe, 0x7b]).write(to: URL(fileURLWithPath: file.path))
        XCTAssertThrowsError(try DaemonConfiguration.load(path: file.path))
    }

    func testPurePathResolutionAndOptionsPrecedence() throws {
        let home = "/synthetic/home"
        XCTAssertEqual(resolveTalkConfigPath(environment: [:], homeDirectory: home), "/synthetic/home/.pi/agent/talk.json")
        XCTAssertEqual(resolveTalkConfigPath(environment: ["PI_CODING_AGENT_DIR": ""], homeDirectory: home), "/synthetic/home/.pi/agent/talk.json")
        XCTAssertEqual(resolveTalkConfigPath(environment: ["PI_CODING_AGENT_DIR": "/custom/agent"], homeDirectory: home), "/custom/agent/talk.json")
        XCTAssertEqual(resolveTalkConfigPath(environment: ["PI_CODING_AGENT_DIR": "~/agent"], homeDirectory: home), "/synthetic/home/agent/talk.json")
        XCTAssertEqual(resolveTalkConfigPath(persistedPath: "/chosen/talk.json", environment: ["PI_CODING_AGENT_DIR": "/env"]), "/chosen/talk.json")
        XCTAssertEqual(resolveTalkConfigPath(explicitPath: "./explicit.json", persistedPath: "/chosen/talk.json", environment: [:], currentDirectory: "/work"), "/work/explicit.json")
        XCTAssertEqual(resolveTalkConfigPath(explicitPath: "~/talk.json", environment: [:], homeDirectory: home), "/synthetic/home/talk.json")
        let first = try TemporaryTalkConfig()
        let second = try TemporaryTalkConfig()
        try first.write()
        try second.write(SharedConfigFixture.json.replacingOccurrences(of: "\"allowedCallers\": [\"Caller\"]", with: "\"allowedCallers\": []"))
        let app = Options(arguments: ["binary", "app"], persistedConfigPath: first.path, environment: ["PI_CODING_AGENT_DIR": second.directory.path])
        XCTAssertNil(app.configError)
        XCTAssertEqual(app.allowedCallers, ["Caller"])
        XCTAssertEqual(app.configPath, first.path)
        let explicit = Options(arguments: ["binary", "app", "--config", second.path], persistedConfigPath: first.path)
        XCTAssertEqual(explicit.configPath, second.path)
        XCTAssertNil(explicit.configError)
        XCTAssertTrue(explicit.allowedCallers.isEmpty)
        let custom = Options(arguments: ["binary", "watch"], environment: ["PI_CODING_AGENT_DIR": first.directory.path])
        XCTAssertEqual(custom.configPath, first.path)
        XCTAssertEqual(custom.allowedCallers, ["Caller"])
    }
}

import Darwin
import XCTest
@testable import FaceTimeObserver

final class ConfigurationTests: XCTestCase {
    func testLoadsV2SharedConfigurationWithPiTalkInBothDirections() throws {
        let file = try TemporaryTalkConfig()
        try file.write()
        let config = try DaemonConfiguration.load(path: file.path)
        XCTAssertEqual(config.allowedCallers, ["Caller"])
        XCTAssertEqual(config.allowedRecipients, ["Recipient"])
        XCTAssertEqual(config.recipientAliases, ["Recipient": ["Recipient alias"]])
        XCTAssertFalse(config.autoAnswer)
        XCTAssertEqual(config.inputDevice, "Pi Talk")
        XCTAssertEqual(config.outputDevice, "Pi Talk")
        XCTAssertEqual(config.json["inputDevice"] as? String, "Pi Talk")
        XCTAssertEqual(config.json["outputDevice"] as? String, "Pi Talk")
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

    func testPhysicalNamesTrimWhitespaceWithoutChangingOpaqueIDsOrFaceTimeRoute() throws {
        var object = try SharedConfigFixture.object()
        var audio = object["audio"] as! [String: Any]
        audio["physical"] = [
            "microphone": ["id": " opaque input ", "name": "  Physical mic  "],
            "speaker": ["id": " opaque output ", "name": " Physical speaker "]
        ]
        object["audio"] = audio
        let config = try SharedConfigFixture.decode(object)
        XCTAssertEqual(config.inputDevice, "Pi Talk")
        XCTAssertEqual(config.outputDevice, "Pi Talk")
        audio["physical"] = [
            "microphone": ["id": " opaque input ", "name": "Physical mic"],
            "speaker": ["id": " opaque output ", "name": "Physical speaker"]
        ]
        object["audio"] = audio
        XCTAssertEqual(config, try SharedConfigFixture.decode(object))
        audio["physical"] = [
            "microphone": ["id": "opaque input", "name": "Physical mic"],
            "speaker": ["id": "opaque output", "name": "Physical speaker"]
        ]
        object["audio"] = audio
        XCTAssertNotEqual(config, try SharedConfigFixture.decode(object))
    }

    func testAbsentOrPartialPhysicalEndpointsDoNotChangeFaceTimeRoute() throws {
        for physical: [String: Any] in [[:], ["microphone": ["id": "m", "name": "Physical mic"]],
                                        ["speaker": ["id": "s", "name": "Physical speaker"]]] {
            var object = try SharedConfigFixture.object()
            var audio = object["audio"] as! [String: Any]
            audio["physical"] = physical
            object["audio"] = audio
            let config = try SharedConfigFixture.decode(object)
            XCTAssertEqual(config.inputDevice, "Pi Talk")
            XCTAssertEqual(config.outputDevice, "Pi Talk")
        }
    }

    func testVirtualUIDsMustBeExactRequiredConstants() throws {
        let original = try SharedConfigFixture.object()
        let originalAudio = original["audio"] as! [String: Any]
        let originalVirtual = originalAudio["virtual"] as! [String: String]
        for key in ["visibleUid", "internalUid"] {
            let uid = originalVirtual[key]!
            for invalid: Any in ["", "Pi Talk", "arbitrary", uid.uppercased(), " " + uid, uid + " ",
                                 uid + "\n", uid + "\u{0000}", uid + ".extra",
                                 originalVirtual[key == "visibleUid" ? "internalUid" : "visibleUid"]!,
                                 7, true, NSNull(), [], ["id": uid]] {
                var object = original
                var audio = originalAudio
                var virtual: [String: Any] = originalVirtual
                virtual[key] = invalid
                audio["virtual"] = virtual
                object["audio"] = audio
                XCTAssertThrowsError(try SharedConfigFixture.decode(object), "\(key)=\(invalid)")
            }
            var object = original
            var audio = originalAudio
            var virtual = originalVirtual
            virtual.removeValue(forKey: key)
            audio["virtual"] = virtual
            object["audio"] = audio
            XCTAssertThrowsError(try SharedConfigFixture.decode(object), "missing \(key)")
        }
        for invalid: Any in [NSNull(), [], "Pi Talk", [:],
                             ["microphone": ["id": "m", "name": "Pi Talk"], "speaker": ["id": "s", "name": "Pi Talk"]],
                             originalVirtual.merging(["extra": "value"]) { _, new in new },
                             originalVirtual.merging(["microphone": "Pi Talk"]) { _, new in new }] {
            var object = original
            var audio = originalAudio
            audio["virtual"] = invalid
            object["audio"] = audio
            XCTAssertThrowsError(try SharedConfigFixture.decode(object))
        }
    }

    func testRejectsUnsupportedVersionsUnknownKeysAndLegacyFields() throws {
        for version: Any in [0, 1, 3, -1, 2.5, "2", true, NSNull()] {
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
        for key in ["physical", "virtual"] {
            var object = try SharedConfigFixture.object()
            var audio = object["audio"] as! [String: Any]
            audio.removeValue(forKey: key)
            object["audio"] = audio
            XCTAssertThrowsError(try SharedConfigFixture.decode(object), "missing audio.\(key)")
        }
        for key in ["audio", "physical"] {
            var object = try SharedConfigFixture.object()
            var audio = object["audio"] as! [String: Any]
            if key == "audio" { audio["extra"] = true }
            else { audio["physical"] = ["extra": true] }
            object["audio"] = audio
            XCTAssertThrowsError(try SharedConfigFixture.decode(object), "unknown \(key) key")
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

    func testPhysicalDeviceBoundsControlsAndUnknownKeys() throws {
        for profile in ["physical"] {
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
            var audio = object["audio"] as! [String: Any]
            audio["physical"] = ["microphone": invalid]
            object["audio"] = audio
            XCTAssertThrowsError(try SharedConfigFixture.decode(object))
        }
        var object = try SharedConfigFixture.object()
        var audio = object["audio"] as! [String: Any]
        audio["physical"] = ["speaker": ["id": String(repeating: "é", count: 256), "name": String(repeating: "é", count: 128)]]
        object["audio"] = audio
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

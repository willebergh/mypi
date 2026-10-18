import Foundation
@testable import FaceTimeObserver

// Shared v2 schema: synthetic physical devices and the fixed Pi Talk UIDs.
enum SharedConfigFixture {
    static let json = #"""
    {
      "version": 2,
      "audio": {
        "physical": {
          "microphone": {"id":"physical-mic", "name":"Physical microphone"},
          "speaker": {"id":"physical-speaker", "name":"Physical speaker"}
        },
        "virtual": {
          "visibleUid": "io.github.willebergh.pitalk.audio.visible",
          "internalUid": "io.github.willebergh.pitalk.audio.internal"
        }
      },
      "facetime": {
        "allowedCallers": ["Caller"],
        "allowedRecipients": ["Recipient"],
        "recipientAliases": {"Recipient":["Recipient alias"]},
        "callStartTimeoutSeconds": 15,
        "ringingTimeoutSeconds": 60
      }
    }
    """#

    static func object() throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
    }

    static func data(_ object: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    static func decode(_ object: [String: Any]) throws -> DaemonConfiguration {
        try JSONDecoder().decode(DaemonConfiguration.self, from: data(object))
    }
}

final class TemporaryTalkConfig {
    let directory: URL
    var path: String { directory.appendingPathComponent("talk.json").path }

    init() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    deinit { try? FileManager.default.removeItem(at: directory) }

    func write(_ json: String = SharedConfigFixture.json) throws {
        try Data(json.utf8).write(to: URL(fileURLWithPath: path))
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
    }

    func writeObject(_ object: [String: Any]) throws {
        try SharedConfigFixture.data(object).write(to: URL(fileURLWithPath: path))
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
    }
}

import Darwin
import Foundation

let talkConfigPathDefaultsKey = "talkConfigPath"

// No filesystem or UserDefaults access: callers supply their environment and
// saved choice. An explicit CLI path always wins, including in app mode.
func resolveTalkConfigPath(explicitPath: String? = nil, persistedPath: String? = nil,
                           environment: [String: String] = ProcessInfo.processInfo.environment,
                           homeDirectory: String = NSHomeDirectory(),
                           currentDirectory: String = FileManager.default.currentDirectoryPath) -> String {
    let base = environment["PI_CODING_AGENT_DIR"].flatMap { $0.isEmpty ? nil : $0 } ?? (homeDirectory as NSString).appendingPathComponent(".pi/agent")
    let path = explicitPath ?? persistedPath ?? (base as NSString).appendingPathComponent("talk.json")
    let expanded: String
    if path == "~" { expanded = homeDirectory }
    else if path.hasPrefix("~/") { expanded = (homeDirectory as NSString).appendingPathComponent(String(path.dropFirst(2))) }
    else { expanded = path }
    return URL(fileURLWithPath: expanded, relativeTo: URL(fileURLWithPath: currentDirectory, isDirectory: true)).standardizedFileURL.path
}

struct TalkConfigurationError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

// Decode only the shared schema, never the old FaceTime-only settings. The
// compatibility properties below are derived, not additional JSON fields.
struct DaemonConfiguration: Decodable, Equatable {
    var allowedCallers: [String] = []
    var allowedRecipients: [String] = []
    var recipientAliases: [String: [String]] = [:]
    var autoAnswer: Bool { false }
    var inputDevice: String? { audio.virtual.speaker?.name }
    var outputDevice: String? { audio.virtual.microphone?.name }
    var callStartTimeoutSeconds: Double = 15
    var ringingTimeoutSeconds: Double = 60
    private var audio = Audio()

    init() {}

    init(from decoder: Decoder) throws {
        let root = try strictContainer(decoder, keys: ["version", "audio", "facetime"])
        guard try root.decode(Int.self, forKey: Key("version")) == 1 else {
            throw TalkConfigurationError(message: "Unsupported Talk config version; expected version 1. Update/migrate this file with Pi, then retry.")
        }
        audio = try root.decode(Audio.self, forKey: Key("audio"))
        let policy = try root.decode(Policy.self, forKey: Key("facetime"))
        allowedCallers = policy.allowedCallers
        allowedRecipients = policy.allowedRecipients
        recipientAliases = policy.recipientAliases
        callStartTimeoutSeconds = policy.callStartTimeoutSeconds
        ringingTimeoutSeconds = policy.ringingTimeoutSeconds
    }

    static func load(path: String) throws -> DaemonConfiguration {
        let path = resolveTalkConfigPath(explicitPath: path)
        // Open the file itself without following a symlink. Validate the opened
        // descriptor, avoiding a stat/read race; O_NONBLOCK also makes FIFOs safe.
        let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else {
            if errno == ENOENT { return DaemonConfiguration() }
            throw TalkConfigurationError(message: "Cannot open Talk config at \(path): \(String(cString: strerror(errno))). Choose a regular, non-symlink file owned by you with chmod 600, then retry.")
        }
        let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? file.close() }
        var info = stat()
        guard fstat(fd, &info) == 0,
              info.st_mode & S_IFMT == S_IFREG,
              info.st_uid == geteuid(),
              info.st_mode & 0o7777 == 0o600 else {
            throw TalkConfigurationError(message: "Talk config must be a regular, non-symlink file owned by the current user with permissions 0600 (run chmod 600 \(path)), then retry.")
        }
        let maxBytes = 64 * 1024
        guard info.st_size >= 0, info.st_size <= off_t(maxBytes) else {
            throw TalkConfigurationError(message: "Talk config exceeds \(maxBytes) bytes at \(path)")
        }
        var data = Data()
        while data.count <= maxBytes {
            guard let chunk = try file.read(upToCount: maxBytes + 1 - data.count), !chunk.isEmpty else { break }
            data.append(chunk)
            guard data.count <= maxBytes else {
                throw TalkConfigurationError(message: "Talk config exceeds \(maxBytes) bytes at \(path)")
            }
        }
        guard !data.isEmpty else {
            throw TalkConfigurationError(message: "Empty shared Talk config at \(path); repair or restore this file, then retry")
        }
        do {
            guard String(data: data, encoding: .utf8) != nil else {
                throw TalkConfigurationError(message: "Config must be valid UTF-8 JSON")
            }
            return try JSONDecoder().decode(DaemonConfiguration.self, from: data)
        } catch {
            throw TalkConfigurationError(message: "Invalid shared Talk config at \(path): \(error). Expected version 1 with audio/facetime sections, not the legacy FaceTime config. Repair/migrate it with Pi, then retry.")
        }
    }

    var json: [String: Any] {
        [
            "allowedCallers": allowedCallers,
            "allowedRecipients": allowedRecipients,
            "recipientAliases": recipientAliases,
            "autoAnswer": autoAnswer,
            "inputDevice": inputDevice ?? NSNull(),
            "outputDevice": outputDevice ?? NSNull(),
            "callStartTimeoutSeconds": callStartTimeoutSeconds,
            "ringingTimeoutSeconds": ringingTimeoutSeconds
        ]
    }
}

private struct Key: CodingKey {
    let stringValue: String
    var intValue: Int? { nil }
    init(_ value: String) { stringValue = value }
    init?(stringValue: String) { self.init(stringValue) }
    init?(intValue: Int) { return nil }
}

private func strictContainer(_ decoder: Decoder, keys: Set<String>) throws -> KeyedDecodingContainer<Key> {
    let values = try decoder.container(keyedBy: Key.self)
    let unknown = Set(values.allKeys.map(\.stringValue)).subtracting(keys)
    guard unknown.isEmpty else {
        throw TalkConfigurationError(message: "Unknown config keys: \(unknown.sorted().joined(separator: ", "))")
    }
    return values
}

private extension KeyedDecodingContainer where Key == FaceTimeObserver.Key {
    // Only device endpoints are optional; explicit null is not a schema value.
    func optional<T: Decodable>(_ type: T.Type, _ name: String) throws -> T? {
        let key = Key(name)
        return contains(key) ? try decode(type, forKey: key) : nil
    }
}

private func validateString(_ value: String, maxBytes: Int = 512) throws {
    let unsafe = value.unicodeScalars.contains {
        $0.value <= 0x1f || (0x7f...0x9f).contains($0.value) ||
        $0.value == 0x61c || $0.value == 0x200e || $0.value == 0x200f ||
        (0x202a...0x202e).contains($0.value) || (0x2066...0x2069).contains($0.value)
    }
    guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          value.utf8.count <= maxBytes, !unsafe else {
        throw TalkConfigurationError(message: "Config strings must be nonempty, at most \(maxBytes) UTF-8 bytes, and contain no C0/C1 or bidi controls")
    }
}

private func validateList(_ values: [String]) throws {
    guard values.count <= 128 else { throw TalkConfigurationError(message: "Config lists must contain at most 128 strings") }
    for value in values { try validateString(value) }
}

private struct Device: Decodable, Equatable {
    let id: String
    let name: String

    init(from decoder: Decoder) throws {
        let values = try strictContainer(decoder, keys: ["id", "name"])
        id = try values.decode(String.self, forKey: Key("id"))
        let rawName = try values.decode(String.self, forKey: Key("name"))
        try validateString(id)
        try validateString(rawName, maxBytes: 256)
        name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

private struct DevicePair: Decodable, Equatable {
    var microphone: Device?
    var speaker: Device?
    init() {}
    init(from decoder: Decoder) throws {
        let values = try strictContainer(decoder, keys: ["microphone", "speaker"])
        microphone = try values.optional(Device.self, "microphone")
        speaker = try values.optional(Device.self, "speaker")
    }
}

private struct Audio: Decodable, Equatable {
    var physical = DevicePair()
    var virtual = DevicePair()
    init() {}
    init(from decoder: Decoder) throws {
        let values = try strictContainer(decoder, keys: ["physical", "virtual"])
        physical = try values.decode(DevicePair.self, forKey: Key("physical"))
        virtual = try values.decode(DevicePair.self, forKey: Key("virtual"))
    }
}

private struct Policy: Decodable {
    var allowedCallers: [String] = []
    var allowedRecipients: [String] = []
    var recipientAliases: [String: [String]] = [:]
    var callStartTimeoutSeconds: Double = 15
    var ringingTimeoutSeconds: Double = 60
    init() {}
    init(from decoder: Decoder) throws {
        let values = try strictContainer(decoder, keys: ["allowedCallers", "allowedRecipients", "recipientAliases", "callStartTimeoutSeconds", "ringingTimeoutSeconds"])
        allowedCallers = try values.decode([String].self, forKey: Key("allowedCallers"))
        allowedRecipients = try values.decode([String].self, forKey: Key("allowedRecipients"))
        recipientAliases = try values.decode([String: [String]].self, forKey: Key("recipientAliases"))
        callStartTimeoutSeconds = try values.decode(Double.self, forKey: Key("callStartTimeoutSeconds"))
        ringingTimeoutSeconds = try values.decode(Double.self, forKey: Key("ringingTimeoutSeconds"))
        try validateList(allowedCallers)
        try validateList(allowedRecipients)
        guard recipientAliases.count <= 128 else { throw TalkConfigurationError(message: "At most 128 recipient aliases are allowed") }
        for (recipient, aliases) in recipientAliases {
            try validateString(recipient)
            try validateList(aliases)
        }
        for timeout in [callStartTimeoutSeconds, ringingTimeoutSeconds] {
            guard timeout.isFinite, (1...3600).contains(timeout) else {
                throw TalkConfigurationError(message: "Timeouts must be finite numbers from 1 to 3600 seconds")
            }
        }
    }
}

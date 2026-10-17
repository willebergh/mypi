import Darwin
import XCTest
@testable import FaceTimeObserver

// Only temporary UNIX sockets and command stubs. No WatchService, AX, or calls.
final class SocketServerTests: XCTestCase {
    func testSingletonFailureAndRepeatedStopCannotUnlinkOwner() throws {
        let path = temporaryPath()
        defer { try? FileManager.default.removeItem(atPath: (path as NSString).deletingLastPathComponent) }
        let first = server(path)
        let contender = server(path)
        defer { first.stop(); contender.stop() }
        try first.start()
        let socketInode = try inode(path)
        let lockInode = try inode(path + ".lock")
        XCTAssertThrowsError(try contender.start())
        contender.stop()
        XCTAssertThrowsError(try first.start())
        XCTAssertEqual(try inode(path), socketInode)
        try assertPermissions(path, 0o600)
        try assertPermissions(path + ".lock", 0o600)
        try assertPermissions((path as NSString).deletingLastPathComponent, 0o700)

        runClient {
            let client = try Connection(path)
            try client.send(jsonLine(["type": "command", "command": "status", "id": "live"]))
            XCTAssertEqual(try client.object()["type"] as? String, "snapshot")
            XCTAssertEqual(try client.object()["id"] as? String, "live")
        }

        first.stop()
        try contender.start()
        first.stop()
        XCTAssertTrue(FileManager.default.fileExists(atPath: path))
        XCTAssertEqual(try inode(path + ".lock"), lockInode)
    }

    func testFailurePreservesNonSocketAndReleasesLock() throws {
        let path = temporaryPath()
        let parent = (path as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: parent, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
        defer { try? FileManager.default.removeItem(atPath: parent) }
        try Data("keep".utf8).write(to: URL(fileURLWithPath: path))
        try Data().write(to: URL(fileURLWithPath: path + ".lock"))
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: path + ".lock")
        let failed = server(path)
        XCTAssertThrowsError(try failed.start())
        failed.stop()
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: path)), Data("keep".utf8))
        try assertPermissions(parent, 0o700)
        try assertPermissions(path + ".lock", 0o600)
        try FileManager.default.removeItem(atPath: path)
        let replacement = server(path)
        defer { replacement.stop() }
        try replacement.start()
        failed.stop()
        XCTAssertTrue(FileManager.default.fileExists(atPath: path))
    }

    func testStaleSocketReclaimedButReplacementInodePreservedOnStop() throws {
        let path = temporaryPath()
        let parent = (path as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: parent, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: parent) }
        Darwin.close(try bindSocket(path)) // Leave a synthetic stale socket.
        let service = server(path)
        defer { service.stop() }
        try service.start()
        XCTAssertEqual(unlink(path), 0)
        let replacement = try bindSocket(path)
        defer { Darwin.close(replacement) }
        let replacementInode = try inode(path)
        service.stop()
        XCTAssertEqual(try inode(path), replacementInode)
    }

    func testFragmentedAndCoalescedFramesAndInitialSnapshotOrdering() throws {
        let path = temporaryPath()
        let service = server(path)
        defer { service.stop(); try? FileManager.default.removeItem(atPath: (path as NSString).deletingLastPathComponent) }
        try service.start()
        runClient {
            let client = try Connection(path)
            var frame = try jsonData(["type": "command", "command": "status", "id": 1])
            frame.append(Data(repeating: 0x20, count: SocketServer.maximumFrameBytes - frame.count))
            try client.send(Data(frame.prefix(100)))
            var rest = Data(frame.dropFirst(100))
            rest.append(0x0a)
            rest.append(jsonLine(["type": "command", "command": "status", "id": 2]))
            rest.append(Data("not json\n".utf8))
            try client.send(rest)
            XCTAssertEqual(try client.object()["type"] as? String, "snapshot")
            // Replies are correlated by id, not completion order (commands may
            // be asynchronous, while invalid JSON is rejected immediately).
            let responses = try [client.object(), client.object(), client.object()]
            XCTAssertEqual(responses.compactMap { $0["id"] as? Int }.sorted(), [1, 2])
            XCTAssertEqual(responses.filter { $0["ok"] as? Bool == false }.count, 1)
            for response in responses {
                XCTAssertEqual(response["protocolVersion"] as? Int, 1)
            }
        }
    }

    func testOversizedFramesDisconnectWithAndWithoutNewline() throws {
        let path = temporaryPath()
        let service = server(path) { _, _ in XCTFail("Oversized command must not be dispatched") }
        defer { service.stop(); try? FileManager.default.removeItem(atPath: (path as NSString).deletingLastPathComponent) }
        try service.start()
        runClient {
            for newline in [false, true] {
                let client = try Connection(path)
                _ = try client.object()
                var frame = Data(repeating: 0x78, count: SocketServer.maximumFrameBytes + 1)
                if newline { frame.append(0x0a) }
                try client.send(frame)
                XCTAssertNil(try client.line())
            }
        }
    }

    func testStalledOutputDisconnectsWithoutBlockingAnotherClientOrMain() throws {
        let path = temporaryPath()
        let service = server(path) { command, reply in
            if command["command"] as? String == "flood" {
                let payload = String(repeating: "x", count: 64 * 1024)
                for _ in 0..<64 { reply(["type": "response", "payload": payload]) }
            } else { reply(["type": "response", "id": command["id"] ?? NSNull(), "ok": true]) }
        }
        defer { service.stop(); try? FileManager.default.removeItem(atPath: (path as NSString).deletingLastPathComponent) }
        try service.start()
        runClient {
            let stalled = try Connection(path)
            _ = try stalled.object()
            try stalled.send(jsonLine(["command": "flood"]))
            // Snapshot creation for this second client requires main; neither
            // initial() nor a broadcast may deadlock behind the stalled writer.
            let healthy = try Connection(path)
            XCTAssertEqual(try healthy.object()["type"] as? String, "snapshot")
            try healthy.send(jsonLine(["command": "status", "id": "healthy"]))
            XCTAssertEqual(try healthy.object()["id"] as? String, "healthy")
            var drained = 0
            while let line = try stalled.line() {
                drained += line.count
                XCTAssertLessThanOrEqual(drained, SocketServer.maximumOutputBytes)
            }
        }
    }

    func testStopDuringInitialSnapshotDoesNotDeadlockOrLeakOwnership() throws {
        let path = temporaryPath()
        weak var weakService: SocketServer?
        let service = SocketServer(path: path, initial: {
            XCTAssertTrue(Thread.isMainThread)
            weakService?.stop()
            return ["type": "snapshot"]
        }, command: { _, _ in XCTFail("No command should run") })
        weakService = service
        defer { service.stop(); try? FileManager.default.removeItem(atPath: (path as NSString).deletingLastPathComponent) }
        try service.start()
        runClient {
            let client = try Connection(path)
            XCTAssertNil(try client.line())
        }
        let next = server(path)
        defer { next.stop() }
        try next.start()
        service.stop()
        XCTAssertTrue(FileManager.default.fileExists(atPath: path))
    }

    func testSnapshotWatermarkPrecedesLaterBroadcast() throws {
        let path = temporaryPath()
        var metadata = ServiceMetadata()
        weak var weakService: SocketServer?
        let service = SocketServer(path: path, initial: {
            let snapshot = metadata.snapshot(["type": "snapshot"], allowedCallers: [])
            DispatchQueue.main.async {
                weakService?.broadcast(metadata.event(["type": "event", "event": "synthetic"], allowedCallers: []))
            }
            return snapshot
        }, command: { _, _ in })
        weakService = service
        defer { service.stop(); try? FileManager.default.removeItem(atPath: (path as NSString).deletingLastPathComponent) }
        try service.start()
        runClient {
            let client = try Connection(path)
            let snapshot = try client.object()
            let event = try client.object()
            XCTAssertEqual(snapshot["type"] as? String, "snapshot")
            XCTAssertEqual(snapshot["seq"] as? Int, 0)
            XCTAssertEqual(event["event"] as? String, "synthetic")
            XCTAssertEqual(event["seq"] as? Int, 1)
            XCTAssertEqual(snapshot["serviceInstanceId"] as? String, event["serviceInstanceId"] as? String)
        }
    }

    private func server(_ path: String, command: @escaping ([String: Any], @escaping ([String: Any]) -> Void) -> Void = { object, reply in
        reply(["type": "response", "id": object["id"] ?? NSNull(), "ok": true])
    }) -> SocketServer {
        SocketServer(path: path, initial: {
            XCTAssertTrue(Thread.isMainThread)
            return ["type": "snapshot", "protocolVersion": 1]
        }, command: command)
    }

    private func temporaryPath() -> String { "/tmp/ft-test-\(UUID().uuidString)/control.sock" }

    private func runClient(_ body: @escaping () throws -> Void) {
        let finished = expectation(description: "synthetic socket client")
        DispatchQueue.global().async {
            defer { finished.fulfill() }
            do { try body() } catch { XCTFail("Socket client: \(error)") }
        }
        wait(for: [finished], timeout: 10)
    }

    private func inode(_ path: String) throws -> ino_t {
        var info = stat()
        guard lstat(path, &info) == 0 else { throw socketTestError("lstat") }
        return info.st_ino
    }

    private func assertPermissions(_ path: String, _ expected: mode_t) throws {
        var info = stat()
        guard lstat(path, &info) == 0 else { throw socketTestError("lstat") }
        XCTAssertEqual(info.st_mode & 0o777, expected)
    }
}

private func socketTestError(_ operation: String) -> Error {
    NSError(domain: NSPOSIXErrorDomain, code: Int(errno), userInfo: [NSLocalizedDescriptionKey: "\(operation): \(String(cString: strerror(errno)))"])
}

private func withAddress<T>(_ path: String, _ body: (UnsafePointer<sockaddr>, socklen_t) -> T) -> T {
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8CString)
    precondition(bytes.count <= MemoryLayout.size(ofValue: address.sun_path))
    withUnsafeMutablePointer(to: &address.sun_path) {
        $0.withMemoryRebound(to: CChar.self, capacity: bytes.count) { target in
            _ = bytes.withUnsafeBufferPointer { memcpy(target, $0.baseAddress!, bytes.count) }
        }
    }
    return withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { body($0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
}

private func bindSocket(_ path: String) throws -> Int32 {
    let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw socketTestError("socket") }
    guard withAddress(path, { Darwin.bind(fd, $0, $1) }) == 0 else {
        let error = socketTestError("bind")
        Darwin.close(fd)
        throw error
    }
    return fd
}

private final class Connection {
    let fd: Int32
    private var buffer = Data()

    init(_ path: String) throws {
        fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw socketTestError("socket") }
        var timeout = timeval(tv_sec: 3, tv_usec: 0)
        var noSigPipe: Int32 = 1
        _ = setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        _ = setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
        guard withAddress(path, { Darwin.connect(fd, $0, $1) }) == 0 else {
            let error = socketTestError("connect")
            Darwin.close(fd)
            throw error
        }
    }

    deinit { Darwin.close(fd) }

    func send(_ data: Data) throws {
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.send(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset, 0)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw socketTestError("send") }
                offset += count
            }
        }
    }

    func line() throws -> Data? {
        while true {
            if let newline = buffer.firstIndex(of: 0x0a) {
                let line = Data(buffer[..<newline])
                buffer.removeSubrange(...newline)
                return line
            }
            var bytes = [UInt8](repeating: 0, count: 8192)
            let count = Darwin.read(fd, &bytes, bytes.count)
            if count == 0 { return nil }
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { throw socketTestError("read") }
            buffer.append(contentsOf: bytes[..<count])
        }
    }

    func object() throws -> [String: Any] {
        guard let line = try line(), let object = try JSONSerialization.jsonObject(with: line) as? [String: Any] else {
            throw NSError(domain: "SocketServerTests", code: 1, userInfo: [NSLocalizedDescriptionKey: "Expected a JSON record"])
        }
        return object
    }
}

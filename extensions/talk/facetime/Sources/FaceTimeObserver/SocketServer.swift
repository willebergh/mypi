@preconcurrency import Dispatch
import Darwin
import Foundation

final class SocketServer: @unchecked Sendable {
    static let maximumFrameBytes = 64 * 1024
    static let maximumOutputBytes = 1024 * 1024

    // Every dispatch source retains the handle through cancellation. Do not
    // recycle an fd until BOTH read and write sources have finished with it.
    private final class SocketHandle {
        let fd: Int32
        init(_ fd: Int32) { self.fd = fd }
        deinit { Darwin.close(fd) }
    }

    // All socket state and nonblocking I/O live on queue. In particular, this
    // queue must never synchronously call main (including through initial).
    private final class Client {
        let handle: SocketHandle
        var fd: Int32 { handle.fd }
        let source: DispatchSourceRead
        var writer: DispatchSourceWrite?
        var buffer = Data()
        var output: [Data] = []
        var offset = 0
        // Admission includes bytes waiting in async send closures, not just
        // bytes already appended to output. Producers never wait for socket I/O.
        private let outputLock = NSLock()
        private var pendingBytes = 0
        private var acceptingOutput = true
        var ready = false
        var readStarted = false
        var closed = false

        init(fd: Int32, source: DispatchSourceRead) {
            self.handle = SocketHandle(fd)
            self.source = source
        }

        // nil means already closing; false requests a single overflow close.
        func reserve(_ count: Int) -> Bool? {
            outputLock.lock()
            defer { outputLock.unlock() }
            guard acceptingOutput else { return nil }
            guard count <= SocketServer.maximumOutputBytes - pendingBytes else {
                acceptingOutput = false
                return false
            }
            pendingBytes += count
            return true
        }

        func consumed(_ count: Int) {
            outputLock.lock()
            pendingBytes -= count
            outputLock.unlock()
        }

        func closeOutput() {
            outputLock.lock()
            acceptingOutput = false
            pendingBytes = 0
            outputLock.unlock()
        }
    }

    let path: String
    private let queue = DispatchQueue(label: "facetime-observer.socket")
    private let queueKey = DispatchSpecificKey<Bool>()
    private var listener: Int32 = -1
    private var lockFD: Int32 = -1
    private var boundIdentity: (dev_t, ino_t)?
    private var acceptSource: DispatchSourceRead?
    private var clients: [Int32: Client] = [:]
    private let initial: () -> [String: Any]
    private let command: ([String: Any], @escaping ([String: Any]) -> Void) -> Void

    init(path: String,
         initial: @escaping () -> [String: Any],
         command: @escaping ([String: Any], @escaping ([String: Any]) -> Void) -> Void) {
        self.path = NSString(string: path).expandingTildeInPath
        self.initial = initial
        self.command = command
        queue.setSpecific(key: queueKey, value: true)
    }

    deinit { stop() }

    func start() throws {
        try onQueue {
            guard lockFD < 0 else { throw serviceError("Socket server is already started") }
            do {
                try startOnQueue()
            } catch {
                stopOnQueue()
                throw error
            }
        }
    }

    private func startOnQueue() throws {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(path.utf8CString)
        guard pathBytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
            throw serviceError("Socket path is too long: \(path)")
        }
        withUnsafeMutablePointer(to: &address.sun_path) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: pathBytes.count) { destination in
                _ = pathBytes.withUnsafeBufferPointer { memcpy(destination, $0.baseAddress!, pathBytes.count) }
            }
        }

        let parent = URL(fileURLWithPath: path).deletingLastPathComponent().path
        try FileManager.default.createDirectory(atPath: parent, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var parentStat = stat()
        guard lstat(parent, &parentStat) == 0,
              parentStat.st_mode & S_IFMT == S_IFDIR, parentStat.st_uid == geteuid() else {
            throw serviceError("Socket parent must be a directory owned by the current user")
        }
        guard chmod(parent, 0o700) == 0 else { throw posixError("chmod parent") }

        // Keep the inode and descriptor for the entire service lifetime. Never
        // unlink the lock file: doing so would allow two different lock inodes.
        let fd = Darwin.open(path + ".lock", O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw posixError("open lock") }
        var lockStat = stat()
        guard fstat(fd, &lockStat) == 0,
              lockStat.st_mode & S_IFMT == S_IFREG, lockStat.st_uid == geteuid() else {
            Darwin.close(fd)
            throw serviceError("Socket lock must be a regular file owned by the current user")
        }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            let error = posixError("lock (another service may be running)")
            Darwin.close(fd)
            throw error
        }
        lockFD = fd
        guard fchmod(fd, 0o600) == 0 else { throw posixError("chmod lock") }

        // Only the lock owner may remove a stale socket, and never other files.
        var existing = stat()
        if lstat(path, &existing) == 0 {
            guard existing.st_mode & S_IFMT == S_IFSOCK else { throw serviceError("Socket path exists and is not a socket") }
            guard unlink(path) == 0 else { throw posixError("unlink stale socket") }
        } else if errno != ENOENT { throw posixError("stat socket") }

        listener = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard listener >= 0 else { throw posixError("socket") }
        try makeNonblocking(listener)
        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard result == 0 else { throw posixError("bind") }
        var bound = stat()
        guard lstat(path, &bound) == 0 else { throw posixError("stat bound socket") }
        boundIdentity = (bound.st_dev, bound.st_ino)
        guard chmod(path, 0o600) == 0 else { throw posixError("chmod socket") }
        guard Darwin.listen(listener, 8) == 0 else { throw posixError("listen") }

        let source = DispatchSource.makeReadSource(fileDescriptor: listener, queue: queue)
        let listenerFD = listener
        source.setEventHandler { [weak self] in self?.acceptClients() }
        source.setCancelHandler { Darwin.close(listenerFD) }
        acceptSource = source
        source.resume()
    }

    func stop() { onQueue { stopOnQueue() } }

    private func stopOnQueue() {
        if let source = acceptSource { source.cancel() }
        else if listener >= 0 { Darwin.close(listener) }
        acceptSource = nil
        listener = -1
        for client in Array(clients.values) { remove(client) }
        // A failed contender (or a repeated stop) never owns this identity.
        if let (device, inode) = boundIdentity {
            var current = stat()
            if lstat(path, &current) == 0, current.st_dev == device, current.st_ino == inode {
                unlink(path)
            }
        }
        boundIdentity = nil
        if lockFD >= 0 { Darwin.close(lockFD); lockFD = -1 }
    }

    func broadcast(_ object: [String: Any]) {
        let data = jsonLine(object)
        queue.async { [weak self] in
            guard let self else { return }
            for client in Array(self.clients.values) where client.ready { self.send(data, to: client) }
        }
    }

    private func acceptClients() {
        guard listener >= 0 else { return }
        // Bound work per dispatch so a connection flood cannot starve writes.
        for _ in 0..<32 {
            let fd = Darwin.accept(listener, nil, nil)
            if fd < 0 { return }
            guard clients.count < 32 else { Darwin.close(fd); continue }
            do { try makeNonblocking(fd) } catch { Darwin.close(fd); continue }
            var noSigPipe: Int32 = 1
            _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
            let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
            let client = Client(fd: fd, source: source)
            source.setEventHandler { [weak self, weak client] in
                if let client { self?.readClient(client) }
            }
            source.setCancelHandler { [handle = client.handle] in withExtendedLifetime(handle) {} }
            clients[fd] = client
            // Snapshot creation is serialized with service events on main. Skip
            // broadcasts until it is enqueued; its seq covers earlier events.
            DispatchQueue.main.async { [weak self, weak client] in
                guard let self, let client else { return }
                let data = jsonLine(self.initial())
                self.queue.async {
                    guard !client.closed else { return }
                    self.send(data, to: client)
                    guard !client.closed else { return }
                    client.ready = true
                    client.readStarted = true
                    source.resume()
                }
            }
        }
    }

    private func readClient(_ client: Client) {
        guard !client.closed else { return }
        var bytes = [UInt8](repeating: 0, count: 8192)
        let length = Darwin.read(client.fd, &bytes, bytes.count)
        if length == 0 { remove(client); return }
        if length < 0 {
            if errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR { remove(client) }
            return
        }
        client.buffer.append(contentsOf: bytes[0..<length])
        while let newline = client.buffer.firstIndex(of: 0x0a) {
            let line = Data(client.buffer[..<newline])
            guard line.count <= Self.maximumFrameBytes else { remove(client); return }
            client.buffer.removeSubrange(...newline)
            if line.isEmpty { continue }
            do {
                guard let object = try JSONSerialization.jsonObject(with: line) as? [String: Any] else {
                    throw serviceError("Command must be a JSON object")
                }
                command(object) { [weak self, weak client] response in
                    guard let self, let client else { return }
                    var response = response
                    response["protocolVersion"] = 1
                    let data = jsonLine(response)
                    self.send(data, to: client)
                }
            } catch {
                send(jsonLine(["type": "response", "protocolVersion": 1, "ok": false, "error": ["code": "invalid_json", "message": error.localizedDescription]]), to: client)
            }
        }
        if client.buffer.count > Self.maximumFrameBytes { remove(client) }
    }

    private func send(_ data: Data, to client: Client) {
        guard let accepted = client.reserve(data.count) else { return }
        if DispatchQueue.getSpecific(key: queueKey) == true {
            if accepted { appendOutput(data, to: client) } else { remove(client) }
        } else {
            queue.async {
                if accepted { self.appendOutput(data, to: client) } else { self.remove(client) }
            }
        }
    }

    private func appendOutput(_ data: Data, to client: Client) {
        guard !client.closed else { return }
        client.output.append(data)
        if client.writer == nil {
            let writer = DispatchSource.makeWriteSource(fileDescriptor: client.fd, queue: queue)
            writer.setEventHandler { [weak self, weak client] in
                if let client { self?.flush(client) }
            }
            writer.setCancelHandler { [handle = client.handle] in withExtendedLifetime(handle) {} }
            client.writer = writer
            writer.resume()
            // Even a single stalled frame must not retain a connection forever.
            queue.asyncAfter(deadline: .now() + 5) { [weak self, weak client, weak writer] in
                guard let client, let writer, client.writer === writer else { return }
                self?.remove(client)
            }
        }
    }

    private func flush(_ client: Client) {
        guard !client.closed else { return }
        var budget = Self.maximumFrameBytes
        while budget > 0, let data = client.output.first {
            let written = data.withUnsafeBytes { buffer in
                Darwin.send(client.fd, buffer.baseAddress!.advanced(by: client.offset), min(budget, data.count - client.offset), 0)
            }
            if written < 0 && errno == EINTR { return }
            if written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) { return }
            guard written > 0 else { remove(client); return }
            client.offset += written
            client.consumed(written)
            budget -= written
            if client.offset == data.count { client.output.removeFirst(); client.offset = 0 }
        }
        if client.output.isEmpty { client.writer?.cancel(); client.writer = nil }
    }

    private func remove(_ client: Client) {
        guard !client.closed else { return }
        client.closed = true
        clients.removeValue(forKey: client.fd)
        client.writer?.cancel()
        client.writer = nil
        client.source.cancel()
        // Dispatch sources must be resumed even when cancelled before startup.
        if !client.readStarted { client.readStarted = true; client.source.resume() }
        client.output.removeAll()
        client.closeOutput()
    }

    private func makeNonblocking(_ fd: Int32) throws {
        let flags = fcntl(fd, F_GETFL)
        guard flags >= 0, fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0,
              fcntl(fd, F_SETFD, FD_CLOEXEC) == 0 else { throw posixError("fcntl") }
    }

    private func onQueue<T>(_ body: () throws -> T) rethrows -> T {
        if DispatchQueue.getSpecific(key: queueKey) == true { return try body() }
        return try queue.sync(execute: body)
    }

    private func serviceError(_ message: String) -> Error {
        NSError(domain: "FaceTimeObserver", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }

    private func posixError(_ operation: String) -> Error {
        NSError(domain: NSPOSIXErrorDomain, code: Int(errno), userInfo: [NSLocalizedDescriptionKey: "\(operation): \(String(cString: strerror(errno)))"])
    }
}

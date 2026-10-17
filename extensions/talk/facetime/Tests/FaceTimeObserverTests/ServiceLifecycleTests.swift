import XCTest
@testable import FaceTimeObserver

final class ServiceLifecycleTests: XCTestCase {
    func testStopPermanentlyInvalidatesWorkFromPreviousRun() {
        let oldRun = ServiceRun()
        var actions: [String] = []
        // The same gate wraps socket ingress, observer events, and timers.
        let queuedCommand = { oldRun.perform { actions.append("command") } }
        let timer = { oldRun.perform { actions.append("timer") } }
        oldRun.perform { actions.append("running") }
        oldRun.stop()
        oldRun.stop()
        let newRun = ServiceRun()
        queuedCommand()
        timer()
        // Delayed auto-answer/outgoing callbacks also test this exact token,
        // rather than a service-wide Boolean that a restart could reactivate.
        XCTAssertFalse(oldRun.isRunning)
        newRun.perform { actions.append("new run") }
        XCTAssertEqual(actions, ["running", "new run"])
        newRun.stop()
    }

    func testAlreadyQueuedAndDelayedCallbacksCannotActAfterStop() {
        let run = ServiceRun()
        let queued = expectation(description: "queued work drained")
        let delayed = expectation(description: "delayed work drained")
        DispatchQueue.main.async {
            run.perform { XCTFail("Stopped queued command must not act") }
            queued.fulfill()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.01) {
            run.perform { XCTFail("Stopped delayed callback must not act") }
            delayed.fulfill()
        }
        run.stop()
        wait(for: [queued, delayed], timeout: 2)
    }

    func testUnstartedServiceStopIsIdempotentAndDoesNotTouchSocket() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("control.sock")
        let contents = Data("not owned by this service".utf8)
        try contents.write(to: path)
        var options = Options(arguments: ["binary", "watch", "--config", directory.appendingPathComponent("missing.json").path])
        options.socketPath = path.path
        let service = WatchService(options: options, emitStdout: false)
        XCTAssertFalse(service.isRunning)
        service.stop()
        service.stop()
        XCTAssertFalse(service.isRunning)
        XCTAssertEqual(try Data(contentsOf: path), contents)
    }

    func testFailedStartResetsRunningStateAndCanBeRetriedWithoutAX() {
        // Path validation fails before filesystem/socket acquisition and before
        // reconcile, so this exercises actual WatchService cleanup without AX.
        var options = Options(arguments: ["binary", "watch", "--config", "/tmp/missing-\(UUID().uuidString).json"])
        options.socketPath = "/tmp/" + String(repeating: "x", count: 256)
        let service = WatchService(options: options, emitStdout: false)
        for _ in 0..<2 {
            XCTAssertThrowsError(try service.start())
            XCTAssertFalse(service.isRunning)
            service.stop()
            service.stop()
            XCTAssertFalse(service.isRunning)
        }
    }
}

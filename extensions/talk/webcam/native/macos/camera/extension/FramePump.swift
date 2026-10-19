import Foundation
import os

enum FrameBoundary: Sendable, Equatable {
    case none, restart, sampleDropped
}

/// Queue-confined demand, timer, pool, sequence and callback. @unchecked Sendable is
/// justified by sync accessors and the private serial queue, not by CMIO thread safety.
final class FramePump: @unchecked Sendable {
    private static let logger = Logger(subsystem: "PiTalkWebcam.CameraExtension", category: "Streaming")
    private let queue = DispatchQueue(label: "PiTalkWebcam.frames", qos: .userInteractive,
                                      autoreleaseFrequency: .workItem)
    private let queueKey = DispatchSpecificKey<UInt8>()
    private let pattern: TestPattern
    private let deliver: (CapturedFrame, FrameBoundary) -> Void
    private var demand = 0
    private var timer: DispatchSourceTimer?
    private var generation: UInt64 = 0
    private var sequence: UInt64 = 0
    private var dropped: UInt64 = 0
    private var pendingBoundary = FrameBoundary.none

    init(pattern: TestPattern, deliver: @escaping (CapturedFrame, FrameBoundary) -> Void) {
        self.pattern = pattern
        self.deliver = deliver
        queue.setSpecific(key: queueKey, value: 1)
    }

    private func serialized<T>(_ action: () throws -> T) rethrows -> T {
        if DispatchQueue.getSpecific(key: queueKey) != nil { return try action() }
        return try queue.sync(execute: action)
    }

    // Internal diagnostics used by the standalone harness; do not register any CMIO objects.
    var activeDemand: Int { serialized { demand } }
    var isRunning: Bool { serialized { timer != nil } }

    func start() throws {
        try serialized {
            guard demand < Int.max else {
                Self.logger.error("Stream demand counter overflow")
                throw CameraError.invalid("Stream demand counter overflow")
            }
            demand += 1
            guard demand == 1 else {
                Self.logger.debug("Stream demand increased to \(self.demand)")
                return
            }
            generation &+= 1
            let currentGeneration = generation
            pendingBoundary = .restart
            dropped = 0
            let source = DispatchSource.makeTimerSource(flags: .strict, queue: queue)
            source.schedule(deadline: .now(), repeating: 1.0 / Double(CameraVideo.framesPerSecond),
                            leeway: .milliseconds(1))
            source.setEventHandler { [weak self] in
                guard let self, self.demand > 0, self.generation == currentGeneration else { return }
                autoreleasepool { self.tick() }
            }
            timer = source
            source.resume()
            Self.logger.notice("Streaming started: 1280x720 BGRA at 30 fps")
        }
    }

    func stop() {
        serialized {
            guard demand > 0 else {
                Self.logger.warning("Ignoring unmatched stream stop")
                return
            }
            demand -= 1
            guard demand == 0 else {
                Self.logger.debug("Stream demand decreased to \(self.demand)")
                return
            }
            stopResources()
        }
    }

    func shutdown() {
        serialized {
            demand = 0
            stopResources()
        }
    }

    private func stopResources() {
        let wasRunning = timer != nil
        generation &+= 1 // Invalidate even a previously enqueued event after a quick restart.
        timer?.cancel()
        timer = nil
        pattern.flushUnusedBuffers()
        if wasRunning { Self.logger.notice("Streaming stopped; unused pixel buffers released") }
    }

    private func tick() {
        defer { sequence &+= 1 }
        do {
            guard let frame = try pattern.makeFrame(sequence: sequence) else {
                recordDrop("Pixel-buffer pool exhausted (consumer backpressure)")
                return
            }
            deliver(frame, pendingBoundary)
            pendingBoundary = .none
        } catch {
            recordDrop(error.localizedDescription)
        }
    }

    private func recordDrop(_ reason: String) {
        pendingBoundary = .sampleDropped
        dropped &+= 1
        // Avoid logging 30 errors/sec while a client holds all five IOSurfaces.
        if dropped == 1 || dropped % 300 == 0 {
            Self.logger.error("Dropping frame: \(reason, privacy: .public); drops=\(self.dropped)")
        }
    }

    deinit {
        // The event handler captures self weakly; it cannot race deinit while using self.
        timer?.cancel()
        pattern.flushUnusedBuffers()
    }
}

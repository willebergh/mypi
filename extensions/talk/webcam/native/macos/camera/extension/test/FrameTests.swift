import Foundation
import CoreMedia
import CoreVideo

private enum TestFailure: Error, CustomStringConvertible {
    case failed(String)
    var description: String {
        switch self { case let .failed(message): return message }
    }
}

private func check(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw TestFailure.failed(message) }
}

private func requireFrame(_ frame: CapturedFrame?) throws -> CapturedFrame {
    guard let frame else { throw TestFailure.failed("Unexpected pool exhaustion") }
    return frame
}

private func expectError(_ body: () throws -> Void) throws {
    do { try body() } catch is CameraError { return }
    throw TestFailure.failed("Expected CameraError")
}

private func withPixels<T>(_ image: CVPixelBuffer,
                           _ body: (UnsafeRawPointer, Int) throws -> T) throws -> T {
    let status = CVPixelBufferLockBaseAddress(image, .readOnly)
    try check(status == kCVReturnSuccess, "Read lock failed")
    defer { CVPixelBufferUnlockBaseAddress(image, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(image) else {
        throw TestFailure.failed("Missing pixel base address")
    }
    return try body(UnsafeRawPointer(base), CVPixelBufferGetBytesPerRow(image))
}

private func pixel(_ image: CVPixelBuffer, x: Int, y: Int) throws -> [UInt8] {
    try withPixels(image) { base, stride in
        let bytes = base.advanced(by: y * stride + x * 4).assumingMemoryBound(to: UInt8.self)
        return (0..<4).map { bytes[$0] }
    }
}

private func imageBuffer(_ frame: CapturedFrame) throws -> CVPixelBuffer {
    guard let image = CMSampleBufferGetImageBuffer(frame.sampleBuffer) else {
        throw TestFailure.failed("Sample has no image")
    }
    return image
}

private func testPixelsAndTiming() throws {
    let pattern = try TestPattern()
    let baseTime = CMClockGetTime(CMClockGetHostTimeClock())
    let first = try requireFrame(pattern.makeFrame(sequence: 0, hostTime: baseTime))
    let secondTime = CMTimeAdd(baseTime, CameraVideo.frameDuration)
    let second = try requireFrame(pattern.makeFrame(sequence: 1, hostTime: secondTime))
    let image = try imageBuffer(first)
    try check(CVPixelBufferGetWidth(image) == 1280, "Width")
    try check(CVPixelBufferGetHeight(image) == 720, "Height")
    try check(CVPixelBufferGetPixelFormatType(image) == kCVPixelFormatType_32BGRA, "BGRA format")
    try check(!CVPixelBufferIsPlanar(image), "Packed format")
    try check(CVPixelBufferGetIOSurface(image) != nil, "IOSurface backing")
    try check(CMVideoFormatDescriptionMatchesImageBuffer(pattern.formatDescription, imageBuffer: image),
              "Sample format does not match buffer")
    try check(CMSampleBufferDataIsReady(first.sampleBuffer), "Sample not ready")
    try check(CMSampleBufferGetNumSamples(first.sampleBuffer) == 1, "Sample count")
    try check(CMTimeCompare(CMSampleBufferGetDuration(first.sampleBuffer), CMTime(value: 1, timescale: 30)) == 0,
              "Duration must be exactly 1/30")
    try check(CMTimeCompare(CMSampleBufferGetPresentationTimeStamp(first.sampleBuffer), baseTime) == 0,
              "PTS must be the supplied host-clock time")
    try check(!CMSampleBufferGetDecodeTimeStamp(first.sampleBuffer).isValid, "Uncompressed DTS should be invalid")
    try check(second.hostTimeInNanoseconds > first.hostTimeInNanoseconds, "Host nanoseconds not monotonic")
    for frame in [first, second] {
        let pts = CMSampleBufferGetPresentationTimeStamp(frame.sampleBuffer)
        let ns = CMTimeConvertScale(pts, timescale: 1_000_000_000, method: .roundTowardZero)
        try check(frame.hostTimeInNanoseconds == UInt64(ns.value), "Send timestamp differs from PTS")
    }
    let delta = CMTimeSubtract(CMSampleBufferGetPresentationTimeStamp(second.sampleBuffer),
                               CMSampleBufferGetPresentationTimeStamp(first.sampleBuffer))
    // Host clock uses integer ticks; 1/30 cannot be represented exactly at its
    // timescale. Duration is exactly 1/30, but host PTS intervals are quantized.
    let interval = CMTimeConvertScale(delta, timescale: 1_000_000_000, method: .roundTowardZero)
    try check(abs(interval.value - 33_333_333) <= 1, "PTS cadence exceeds host-clock quantization")

    let expectedBGRA: [[UInt8]] = [
        [255, 255, 255, 255], [0, 255, 255, 255], [255, 255, 0, 255], [0, 255, 0, 255],
        [255, 0, 255, 255], [0, 0, 255, 255], [255, 0, 0, 255], [32, 32, 32, 255]
    ]
    for index in 0..<8 {
        let value = try pixel(image, x: index * 160 + 80, y: 400)
        try check(value == expectedBGRA[index], "Bar \(index) has wrong BGRA byte order/color")
    }
    let firstBox = try pixel(image, x: 0, y: 10)
    let secondBox = try pixel(imageBuffer(second), x: 0, y: 10)
    try check(firstBox == [0, 128, 255, 255] && secondBox == [255, 255, 255, 255], "Box did not move")
    let shiftedBar = try pixel(imageBuffer(second), x: 159, y: 400)
    try check(shiftedBar == [0, 255, 255, 255], "Colored bars did not animate")
    let lineFrame = try requireFrame(pattern.makeFrame(
        sequence: 100, hostTime: CMTimeAdd(baseTime, CMTime(value: 100, timescale: 30))))
    let linePixel = try pixel(imageBuffer(lineFrame), x: 1279, y: 100)
    try check(linePixel == [255, 255, 255, 255], "Moving scanline missing")
    try withPixels(image) { base, stride in
        for y in 0..<720 {
            let row = base.advanced(by: y * stride).assumingMemoryBound(to: UInt8.self)
            for x in 0..<1280 { try check(row[x * 4 + 3] == 255, "Non-opaque pixel") }
            for offset in (1280 * 4)..<stride { try check(row[offset] == 0, "Uninitialized padding") }
        }
    }
    try expectError { _ = try pattern.makeFrame(sequence: 101, hostTime: .invalid) }
    try expectError { _ = try pattern.makeFrame(sequence: 101, hostTime: baseTime) }
    var wrongSize: CVPixelBuffer?
    let status = CVPixelBufferCreate(kCFAllocatorDefault, 16, 16, kCVPixelFormatType_32BGRA, nil, &wrongSize)
    try check(status == kCVReturnSuccess, "Invalid-size fixture creation")
    guard let wrongSize else { throw TestFailure.failed("Missing invalid-size fixture") }
    try expectError { try TestPattern.render(into: wrongSize, sequence: 0) }
    print("PASS pixels, moving box/line, IOSurface, sample format/duration, host PTS/nanoseconds, invalid inputs")
}

private func testPoolBound() throws {
    let pattern = try TestPattern()
    let start = CMClockGetTime(CMClockGetHostTimeClock())
    var held: [CapturedFrame] = []
    func time(_ index: Int64) -> CMTime { CMTimeAdd(start, CMTime(value: index, timescale: 30)) }
    for index in 0..<CameraVideo.maximumBuffers {
        let frame = try autoreleasepool {
            try requireFrame(pattern.makeFrame(sequence: UInt64(index), hostTime: time(Int64(index))))
        }
        held.append(frame)
    }
    try check(held.count == 5, "Must hold exactly five pool buffers")
    let exhausted = try pattern.makeFrame(sequence: 5, hostTime: time(5))
    try check(exhausted == nil, "Pool allocated beyond cap")
    pattern.flushUnusedBuffers() // Mimics stop, including while consumers retain all frames.
    let stillExhausted = try pattern.makeFrame(sequence: 6, hostTime: time(6))
    try check(stillExhausted == nil, "Flush/restart bypassed cap")
    held.removeFirst()
    try autoreleasepool {
        let recovered = try requireFrame(pattern.makeFrame(sequence: 7, hostTime: time(7)))
        try check(recovered.hostTimeInNanoseconds > held.last!.hostTimeInNanoseconds, "Recovery timestamp")
    }
    held.removeAll()
    pattern.flushUnusedBuffers()
    for index in 8..<38 {
        try autoreleasepool {
            _ = try requireFrame(pattern.makeFrame(sequence: UInt64(index), hostTime: time(Int64(index))))
        }
    }
    print("PASS five-buffer cap, drop without blocking, cap across flush, recovery and reuse")
}

private final class DeliveryProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    private var previous: UInt64 = 0
    private var failure: String?
    private var discontinuities = 0

    func receive(_ frame: CapturedFrame, _ boundary: FrameBoundary) {
        lock.lock()
        defer { lock.unlock() }
        if count > 0 && frame.hostTimeInNanoseconds <= previous { failure = "Pump host time regressed" }
        previous = frame.hostTimeInNanoseconds
        if boundary != .none { discontinuities += 1 }
        count += 1
    }

    var snapshot: (count: Int, failure: String?, discontinuities: Int) {
        lock.lock()
        defer { lock.unlock() }
        return (count, failure, discontinuities)
    }

    func waitForCount(_ target: Int) throws {
        let deadline = DispatchTime.now().uptimeNanoseconds + 3_000_000_000
        while snapshot.count < target && DispatchTime.now().uptimeNanoseconds < deadline {
            Thread.sleep(forTimeInterval: 0.005)
        }
        try check(snapshot.count >= target, "Timed out waiting for synthetic pump frames")
    }
}

private func testDemandAndCleanup() throws {
    let probe = DeliveryProbe()
    let pump = FramePump(pattern: try TestPattern(), deliver: probe.receive)
    defer { pump.shutdown() }
    try pump.start()
    try pump.start()
    try check(pump.activeDemand == 2 && pump.isRunning, "Second start must share timer")
    try probe.waitForCount(3)
    pump.stop()
    try check(pump.activeDemand == 1 && pump.isRunning, "First stop interrupted another consumer")
    try probe.waitForCount(probe.snapshot.count + 2)
    pump.stop()
    try check(pump.activeDemand == 0 && !pump.isRunning, "Final stop did not cancel timer")
    let stopped = probe.snapshot.count
    Thread.sleep(forTimeInterval: 0.15)
    try check(probe.snapshot.count == stopped, "Delivery continued after final stop returned")
    pump.stop()
    try check(pump.activeDemand == 0, "Unmatched stop underflowed")
    try pump.start()
    try probe.waitForCount(stopped + 2)
    pump.shutdown()
    try check(pump.activeDemand == 0 && !pump.isRunning, "Shutdown resources")
    try check(probe.snapshot.failure == nil, probe.snapshot.failure ?? "Timestamp regression")
    try check(probe.snapshot.discontinuities >= 2, "Restart should flag discontinuity")

    // Concurrent caller stress; a baseline consumer must keep the shared timer alive.
    try pump.start()
    let errors = DeliveryProbe()
    DispatchQueue.concurrentPerform(iterations: 64) { _ in
        do { try pump.start() } catch { errors.recordStartFailure() }
        pump.stop()
    }
    try check(errors.snapshot.failure == nil, "Concurrent start failed")
    try check(pump.activeDemand == 1 && pump.isRunning, "Concurrent demand not balanced")
    pump.stop()
    let finalCount = probe.snapshot.count
    Thread.sleep(forTimeInterval: 0.1)
    try check(probe.snapshot.count == finalCount, "Stale timer event after stress stop")
    print("PASS reference-counted demand, restart, no delivery after stop, shutdown, concurrent callbacks")
}

private extension DeliveryProbe {
    func recordStartFailure() {
        lock.lock()
        failure = "Concurrent start threw"
        lock.unlock()
    }
}

@main
struct FrameTests {
    static func main() {
        guard CommandLine.arguments == [CommandLine.arguments[0], "--self-test"] else {
            print("Usage: \(CommandLine.arguments[0]) --self-test (synthetic buffers only; no CMIO service)")
            exit(EXIT_FAILURE)
        }
        do {
            try autoreleasepool { try testPixelsAndTiming() }
            try autoreleasepool { try testPoolBound() }
            try testDemandAndCleanup()
            print("PASS all standalone tests (no provider registration, physical camera, or CMIO daemon)")
        } catch {
            print("FAIL: \(error)")
            exit(EXIT_FAILURE)
        }
    }
}

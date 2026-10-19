import Foundation
import CoreMedia
import CoreVideo

// No CMIO registration or physical-camera APIs: also compiled into test/FrameTests.swift.
enum CameraVideo {
    static let width = 1280
    static let height = 720
    static let framesPerSecond: Int32 = 30
    static let frameDuration = CMTime(value: 1, timescale: framesPerSecond)
    static let pixelFormat = kCVPixelFormatType_32BGRA
    static let maximumBuffers = 5
}

enum CameraError: Error, LocalizedError {
    case failure(String, Int32)
    case invalid(String)

    var errorDescription: String? {
        switch self {
        case let .failure(operation, status): return "\(operation) failed (\(status))"
        case let .invalid(message): return message
        }
    }
}

struct CapturedFrame {
    let sampleBuffer: CMSampleBuffer
    let hostTimeInNanoseconds: UInt64
}

/// All mutable access must be serialized by the caller (FramePump does this).
final class TestPattern {
    let formatDescription: CMVideoFormatDescription
    private let pool: CVPixelBufferPool
    private let allocationAttributes = [
        kCVPixelBufferPoolAllocationThresholdKey: CameraVideo.maximumBuffers
    ] as CFDictionary
    private var lastHostNanoseconds: UInt64?

    init() throws {
        var description: CMVideoFormatDescription?
        let formatStatus = CMVideoFormatDescriptionCreate(
            allocator: kCFAllocatorDefault, codecType: CameraVideo.pixelFormat,
            width: Int32(CameraVideo.width), height: Int32(CameraVideo.height),
            extensions: nil, formatDescriptionOut: &description)
        guard formatStatus == noErr, let description else {
            throw CameraError.failure("CMVideoFormatDescriptionCreate", formatStatus)
        }
        formatDescription = description

        let attributes: [CFString: Any] = [
            kCVPixelBufferWidthKey: CameraVideo.width,
            kCVPixelBufferHeightKey: CameraVideo.height,
            kCVPixelBufferPixelFormatTypeKey: CameraVideo.pixelFormat,
            kCVPixelBufferBytesPerRowAlignmentKey: 64,
            kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary
        ]
        var createdPool: CVPixelBufferPool?
        let poolStatus = CVPixelBufferPoolCreate(
            kCFAllocatorDefault, nil, attributes as CFDictionary, &createdPool)
        guard poolStatus == kCVReturnSuccess, let createdPool else {
            throw CameraError.failure("CVPixelBufferPoolCreate", poolStatus)
        }
        pool = createdPool
    }

    /// nil means consumer backpressure: never wait, allocate outside the pool, or queue frames.
    /// PTS and the send timestamp describe the SAME host-clock capture instant. Integer
    /// rescaling avoids Double precision loss and does not confuse mach ticks with nanoseconds.
    func makeFrame(sequence: UInt64,
                   hostTime: CMTime = CMClockGetTime(CMClockGetHostTimeClock())) throws -> CapturedFrame? {
        let nanoseconds = CMTimeConvertScale(hostTime, timescale: 1_000_000_000, method: .roundTowardZero)
        guard hostTime.isNumeric, hostTime.epoch == 0,
              nanoseconds.isNumeric, nanoseconds.value >= 0 else {
            throw CameraError.invalid("Invalid host-clock timestamp")
        }
        let hostNanoseconds = UInt64(nanoseconds.value)
        if let lastHostNanoseconds, hostNanoseconds <= lastHostNanoseconds {
            throw CameraError.invalid("Host-clock timestamp did not increase")
        }

        var image: CVPixelBuffer?
        let status = CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(
            kCFAllocatorDefault, pool, allocationAttributes, &image)
        if status == kCVReturnWouldExceedAllocationThreshold { return nil }
        guard status == kCVReturnSuccess, let image else {
            throw CameraError.failure("CVPixelBufferPoolCreatePixelBufferWithAuxAttributes", status)
        }
        try Self.render(into: image, sequence: sequence)

        var timing = CMSampleTimingInfo(
            duration: CameraVideo.frameDuration, presentationTimeStamp: hostTime,
            decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        let sampleStatus = CMSampleBufferCreateForImageBuffer(
            allocator: kCFAllocatorDefault, imageBuffer: image, dataReady: true,
            makeDataReadyCallback: nil, refcon: nil, formatDescription: formatDescription,
            sampleTiming: &timing, sampleBufferOut: &sample)
        guard sampleStatus == noErr, let sample else {
            throw CameraError.failure("CMSampleBufferCreateForImageBuffer", sampleStatus)
        }
        lastHostNanoseconds = hostNanoseconds
        return CapturedFrame(sampleBuffer: sample, hostTimeInNanoseconds: hostNanoseconds)
    }

    /// Free unused IOSurfaces on stop. Keep the SAME pool across restarts: buffers still
    /// retained by consumers must continue to count toward the allocation threshold.
    func flushUnusedBuffers() {
        CVPixelBufferPoolFlush(pool, .excessBuffers)
    }

    static func render(into image: CVPixelBuffer, sequence: UInt64) throws {
        guard CVPixelBufferGetPixelFormatType(image) == CameraVideo.pixelFormat,
              !CVPixelBufferIsPlanar(image),
              CVPixelBufferGetWidth(image) == CameraVideo.width,
              CVPixelBufferGetHeight(image) == CameraVideo.height else {
            throw CameraError.invalid("Expected packed 1280x720 BGRA pixel buffer")
        }
        let lockStatus = CVPixelBufferLockBaseAddress(image, [])
        guard lockStatus == kCVReturnSuccess else {
            throw CameraError.failure("CVPixelBufferLockBaseAddress", lockStatus)
        }
        defer { CVPixelBufferUnlockBaseAddress(image, []) }
        guard let base = CVPixelBufferGetBaseAddress(image) else {
            throw CameraError.invalid("Pixel buffer has no CPU base address")
        }
        let stride = CVPixelBufferGetBytesPerRow(image)
        guard stride >= CameraVideo.width * 4 else {
            throw CameraError.invalid("Pixel buffer row stride is too short")
        }
        // Little-endian UInt32 values give byte order B, G, R, A on arm64.
        let colors: [UInt32] = [
            0xFFFFFFFF, 0xFFFFFF00, 0xFF00FFFF, 0xFF00FF00,
            0xFFFF00FF, 0xFFFF0000, 0xFF0000FF, 0xFF202020
        ]
        let barOffset = Int(sequence % UInt64(CameraVideo.width))
        let boxSize = 96
        let boxX = Int((sequence % UInt64(CameraVideo.width - boxSize + 1)) * 7
                       % UInt64(CameraVideo.width - boxSize + 1))
        let boxY = Int((sequence % UInt64(CameraVideo.height - boxSize + 1)) * 3
                       % UInt64(CameraVideo.height - boxSize + 1))
        let lineY = Int(sequence % UInt64(CameraVideo.height))
        for y in 0..<CameraVideo.height {
            let rowBase = base.advanced(by: y * stride)
            // Clear row padding too; consumers must never see uninitialized bytes.
            memset(rowBase, 0, stride)
            let row = rowBase.assumingMemoryBound(to: UInt32.self)
            for x in 0..<CameraVideo.width {
                let shiftedX = x + barOffset
                let wrappedX = shiftedX >= CameraVideo.width ? shiftedX - CameraVideo.width : shiftedX
                row[x] = colors[wrappedX * colors.count / CameraVideo.width]
            }
            if y >= boxY && y < boxY + boxSize {
                for x in boxX..<(boxX + boxSize) { row[x] = 0xFFFF8000 }
            }
            if y == lineY || y == (lineY + 1) % CameraVideo.height {
                for x in 0..<CameraVideo.width { row[x] = 0xFFFFFFFF }
            }
        }
    }
}

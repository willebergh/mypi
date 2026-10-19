// Standalone, read-only VirtualCamera4Mac receiver. No format/property writes.
// Build: xcrun clang++ -std=c++17 -O2 -fobjc-arc receive.mm -o /tmp/vc4m-receive 
//   -framework Foundation -framework CoreMediaIO -framework CoreMedia -framework CoreVideo
//   -framework CoreGraphics -framework ImageIO
// Run: /tmp/vc4m-receive [seconds=10] [--portrait-fit] (0 < seconds <= 600)
// Exit: 0 = motion + contrast + expected format; 2 = inconclusive; 1 = API/error.
// Reference: m96-chan/VirtualCamera4Mac v0.0.7 (26f8f2df), Sources/
// Extension/ExtensionProvider.swift, Producer/VirtualCameraSink.swift and
// VirtualCameraCore/FormatCatalog.swift. Source direction maps to CMIO input (1).
// SDK CMIOHardwareStream.h: callback token identifies insertion/removal; it is
// NOT a separately owned sample. CopyBufferQueue returns an owned queue and
// calling it with a NULL callback unregisters. CMSimpleQueue.h: queue elements
// are unmanaged, with exactly one dequeueing thread. CMIO sample queue handoff
// transfers a +1 sample to the consumer (also documented by upstream's sink).
// Release each dequeued CMSampleBuffer once; never release the callback token.
#import <Foundation/Foundation.h>
#import <CoreMediaIO/CoreMediaIO.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ImageIO/ImageIO.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

using Clock = std::chrono::steady_clock;
static std::atomic<uint64_t> notifications{0};
static volatile sig_atomic_t interrupted = 0;
static void onSignal(int) { interrupted = 1; }
static void queueChanged(CMIOStreamID, void*, void*) {
    // Process-lifetime state only: late callbacks cannot touch freed queue/state.
    // No sample access, allocation, locks, or dequeueing on the callback thread.
    notifications.fetch_add(1, std::memory_order_relaxed);
}
static CMIOObjectPropertyAddress address(CMIOObjectPropertySelector selector,
    CMIOObjectPropertyScope scope = kCMIOObjectPropertyScopeGlobal) {
    return {selector, scope, kCMIOObjectPropertyElementMain};
}
static void check(OSStatus status, const char* operation) {
    if (status) throw std::runtime_error(std::string(operation) + ": OSStatus " + std::to_string(status));
}
template<class T> static T property(CMIOObjectID object, CMIOObjectPropertySelector selector) {
    auto a = address(selector);
    T value{};
    UInt32 used = 0;
    check(CMIOObjectGetPropertyData(object, &a, 0, nullptr, sizeof(value), &used, &value), "get property");
    if (used != sizeof(value)) throw std::runtime_error("unexpected property size");
    return value;
}
static std::vector<CMIOObjectID> objects(CMIOObjectID object,
    CMIOObjectPropertySelector selector, CMIOObjectPropertyScope scope = kCMIOObjectPropertyScopeGlobal) {
    auto a = address(selector, scope);
    UInt32 size = 0, used = 0;
    check(CMIOObjectGetPropertyDataSize(object, &a, 0, nullptr, &size), "get list size");
    if (size % sizeof(CMIOObjectID)) throw std::runtime_error("invalid object list size");
    std::vector<CMIOObjectID> result(size / sizeof(CMIOObjectID));
    if (size) check(CMIOObjectGetPropertyData(object, &a, 0, nullptr, size, &used, result.data()), "get list");
    if (used > size || used % sizeof(CMIOObjectID)) throw std::runtime_error("object list changed; retry");
    result.resize(used / sizeof(CMIOObjectID));
    return result;
}
struct Receiver {
    CMIODeviceID device = 0;
    CMIOStreamID stream = 0;
    CMSimpleQueueRef queue = nullptr;
    bool registered = false, started = false;
    OSStatus stopStatus = 0, unregisterStatus = 0;
    uint64_t drained = 0;
    void close() {
        if (started) { stopStatus = CMIODeviceStopStream(device, stream); started = false; }
        if (registered) {
            CMSimpleQueueRef extra = nullptr;
            unregisterStatus = CMIOStreamCopyBufferQueue(stream, nullptr, nullptr, &extra);
            if (extra) CFRelease(extra);
            registered = false;
        }
        if (queue) {
            // Single consumer throughout. Bound drain even if StopStream failed.
            const int capacity = CMSimpleQueueGetCapacity(queue);
            for (int i = 0; i < capacity; ++i) {
                const void* item = CMSimpleQueueDequeue(queue);
                if (!item) break;
                CFRelease(item);
                ++drained;
            }
            CFRelease(queue);
            queue = nullptr;
        }
    }
    ~Receiver() { close(); }
};
// Optional one-frame diagnostic capture, never used by the producer.
static bool savePNG(const uint8_t* base, size_t width, size_t height, size_t stride, const char* filename) {
    CGColorSpaceRef color = CGColorSpaceCreateDeviceRGB();
    CGDataProviderRef provider = CGDataProviderCreateWithData(nullptr, base, stride * height, nullptr);
    CGImageRef image = CGImageCreate(width, height, 8, 32, stride, color,
        kCGBitmapByteOrder32Little | kCGImageAlphaPremultipliedFirst, provider, nullptr, false, kCGRenderingIntentDefault);
    NSURL* url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:filename]];
    CGImageDestinationRef destination = CGImageDestinationCreateWithURL((__bridge CFURLRef)url, CFSTR("public.png"), 1, nullptr);
    bool saved = false;
    if (image && destination) { CGImageDestinationAddImage(destination, image, nullptr); saved = CGImageDestinationFinalize(destination); }
    if (destination) CFRelease(destination);
    if (image) CGImageRelease(image);
    if (provider) CGDataProviderRelease(provider);
    if (color) CGColorSpaceRelease(color);
    return saved;
}
struct Stats {
    const char* pngPath = std::getenv("VC4M_RECEIVER_PNG");
    bool pngAttempted = false, pngSaved = false;
    uint64_t frames = 0, expected = 0, sampled = 0, invalid = 0, lockErrors = 0;
    uint64_t changes = 0, contrastFrames = 0, previousHash = 0;
    bool portraitFit = false;
    uint64_t pillarFrames = 0, centerContrastFrames = 0, colorCenterFrames = 0;
    uint64_t fitFrames = 0, fitChanges = 0, previousFitHash = 0;
    int activeMinX = 1280, activeMaxX = -1;
    int lastActiveMinX = 1280, lastActiveMaxX = -1;
    void inspectPortrait(const uint8_t* base, size_t stride) {
        // Expected viewport [437.5,842.5). Avoid fractional edge coverage.
        // Bounds describe visible RGB > 2, not the geometry of a dark source.
        bool pillars = true, color = false;
        unsigned low = 255, high = 0;
        uint64_t hash = 14695981039346656037ULL;
        int minX = 1280, maxX = -1;
        for (int y = 10; y < 720; y += 20) {
            for (int x = 0; x < 1280; x += 4) {
                const uint8_t* p = base + y * stride + x * 4;
                const unsigned rgbMax = std::max({p[0], p[1], p[2]});
                const unsigned rgbMin = std::min({p[0], p[1], p[2]});
                if (rgbMax > 2) { minX = std::min(minX, x); maxX = std::max(maxX, x); }
                // Includes the requested x=100 and x=1180 probes on every row.
                if (x <= 436 || x >= 844) {
                    if (rgbMax > 2 || p[3] != 255) pillars = false;
                } else {
                    for (int c = 0; c < 3; ++c) { hash ^= p[c]; hash *= 1099511628211ULL; }
                    const unsigned luma = (29u * p[0] + 150u * p[1] + 77u * p[2]) >> 8;
                    low = std::min(low, luma); high = std::max(high, luma);
                    if (rgbMax - rgbMin >= 24) color = true;
                }
            }
        }
        lastActiveMinX = minX; lastActiveMaxX = maxX;
        if (pillars) ++pillarFrames;
        if (high - low >= 24) ++centerContrastFrames;
        if (color) ++colorCenterFrames;
        // Compare interior hashes only between fitting, contrasted frames:
        // transition/standby frames neither fail the run nor supply motion.
        if (pillars && high - low >= 24) {
            if (fitFrames && hash != previousFitHash) ++fitChanges;
            previousFitHash = hash;
            ++fitFrames;
            activeMinX = std::min(activeMinX, minX);
            activeMaxX = std::max(activeMaxX, maxX);
        }
    }
    double firstArrival = 0, lastArrival = 0, ptsSum = 0, lastPTS = NAN;
    uint64_t ptsIntervals = 0;
    double contrastSum = 0, maxContrast = 0;
    std::set<uint64_t> hashes;
    NSMutableDictionary* formats = [NSMutableDictionary dictionary];
    void consume(CMSampleBufferRef sample) {
        ++frames;
        const double now = std::chrono::duration<double>(Clock::now().time_since_epoch()).count();
        if (frames == 1) firstArrival = now;
        lastArrival = now;
        const double pts = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample));
        if (std::isfinite(pts) && std::isfinite(lastPTS) && pts > lastPTS) {
            ptsSum += pts - lastPTS; ++ptsIntervals;
        }
        lastPTS = pts;
        CVPixelBufferRef pixel = CMSampleBufferGetImageBuffer(sample); // borrowed
        if (!pixel) { ++invalid; return; }
        const size_t w = CVPixelBufferGetWidth(pixel), h = CVPixelBufferGetHeight(pixel);
        const OSType format = CVPixelBufferGetPixelFormatType(pixel);
        NSString* key = [NSString stringWithFormat:@"%zux%zu/0x%08x", w, h, (unsigned)format];
        formats[key] = @([formats[key] unsignedLongLongValue] + 1);
        if (w != 1280 || h != 720 || format != kCVPixelFormatType_32BGRA || CVPixelBufferIsPlanar(pixel)) return;
        ++expected;
        // Hard cap on total diagnostic work/storage, plus 64*36 pixels per frame.
        if (sampled >= 10000) return;
        if (CVPixelBufferLockBaseAddress(pixel, kCVPixelBufferLock_ReadOnly)) { ++lockErrors; return; }
        const auto* base = static_cast<const uint8_t*>(CVPixelBufferGetBaseAddress(pixel));
        const size_t stride = CVPixelBufferGetBytesPerRow(pixel);
        if (!base || stride < w * 4) {
            ++invalid;
            CVPixelBufferUnlockBaseAddress(pixel, kCVPixelBufferLock_ReadOnly);
            return;
        }
        uint64_t hash = 14695981039346656037ULL;
        unsigned low = 255, high = 0;
        for (size_t gy = 0; gy < 36; ++gy) for (size_t gx = 0; gx < 64; ++gx) {
            const size_t x = (2 * gx + 1) * w / 128, y = (2 * gy + 1) * h / 72;
            const uint8_t* p = base + y * stride + x * 4;
            for (int c = 0; c < 3; ++c) { hash ^= p[c]; hash *= 1099511628211ULL; }
            const unsigned luminance = (29u * p[0] + 150u * p[1] + 77u * p[2]) >> 8;
            low = std::min(low, luminance); high = std::max(high, luminance);
        }
        if (portraitFit) inspectPortrait(base, stride);
        if (pngPath && *pngPath && !pngAttempted) {
            pngAttempted = true;
            pngSaved = savePNG(base, w, h, stride, pngPath);
        }
        CVPixelBufferUnlockBaseAddress(pixel, kCVPixelBufferLock_ReadOnly);
        if (sampled && hash != previousHash) ++changes;
        previousHash = hash;
        hashes.insert(hash);
        ++sampled;
        const double contrast = high - low;
        contrastSum += contrast;
        maxContrast = std::max(maxContrast, contrast);
        if (contrast >= 24) ++contrastFrames;
    }
};
int main(int argc, char** argv) {
    @autoreleasepool {
        NSMutableDictionary* report = [NSMutableDictionary dictionary];
        Receiver receiver;
        Stats stats;
        int result = 1;
        double seconds = 10;
        const auto begin = Clock::now();
        try {
            char* end = nullptr;
            int positionalEnd = argc;
            if (argc > 1 && std::string(argv[argc - 1]) == "--portrait-fit") {
                stats.portraitFit = true;
                --positionalEnd;
            }
            if (positionalEnd > 2) throw std::runtime_error("usage: receive [seconds=10] [--portrait-fit], 0 < seconds <= 600");
            if (positionalEnd == 2) {
                seconds = strtod(argv[1], &end);
                if (end == argv[1] || *end || !std::isfinite(seconds) || seconds <= 0 || seconds > 600)
                    throw std::runtime_error("seconds must be finite and in (0,600]");
            }
            signal(SIGINT, onSignal); signal(SIGTERM, onSignal);
            for (auto device : objects(kCMIOObjectSystemObject, kCMIOHardwarePropertyDevices)) {
                CFStringRef uid = property<CFStringRef>(device, kCMIODevicePropertyDeviceUID);
                const bool match = uid && CFEqual(uid, CFSTR("B9E1C0F2-6A2E-4B7D-9C3A-2F1E7D4A5C6B"));
                if (uid) CFRelease(uid);
                if (match) { receiver.device = device; break; }
            }
            if (!receiver.device) throw std::runtime_error("VirtualCamera4Mac UID not found; no activation changes attempted");
            for (auto stream : objects(receiver.device, kCMIODevicePropertyStreams)) {
                if (property<UInt32>(stream, kCMIOStreamPropertyDirection) == 1) {
                    receiver.stream = stream; break;
                }
            }
            if (!receiver.stream) throw std::runtime_error("no input/source stream found");
            const OSStatus copied = CMIOStreamCopyBufferQueue(receiver.stream, queueChanged, nullptr, &receiver.queue);
            receiver.registered = copied == noErr;
            check(copied, "CopyBufferQueue");
            if (!receiver.queue) throw std::runtime_error("CopyBufferQueue returned null");
            check(CMIODeviceStartStream(receiver.device, receiver.stream), "StartStream");
            receiver.started = true;
            const auto deadline = Clock::now() + std::chrono::duration<double>(seconds);
            while (!interrupted && Clock::now() < deadline) {
                // Main thread is the sole queue consumer; poll as a lost-notification
                // fallback and pump the run loop for CMIO service delivery.
                const int capacity = CMSimpleQueueGetCapacity(receiver.queue);
                for (int i = 0; i < capacity && Clock::now() < deadline; ++i) {
                    const void* item = CMSimpleQueueDequeue(receiver.queue);
                    if (!item) break;
                    auto sample = (CMSampleBufferRef)item;
                    try { stats.consume(sample); }
                    catch (...) { CFRelease(sample); throw; }
                    CFRelease(sample);
                }
                CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.002, false);
            }
            result = !interrupted && !stats.invalid && !stats.lockErrors &&
                stats.expected == stats.frames && stats.sampled >= 3 &&
                (stats.portraitFit ? stats.fitFrames >= 3 && stats.fitChanges >= 2 :
                    stats.changes >= 2 && stats.contrastFrames >= 3) ? 0 : 2;
        } catch (const std::exception& error) {
            report[@"error"] = [NSString stringWithUTF8String:error.what()];
        }
        receiver.close();
        if (receiver.stopStatus || receiver.unregisterStatus) result = 1;
        report[@"status"] = result == 0 ? @"motion_and_contrast_observed" : result == 2 ? @"inconclusive" : @"error";
        report[@"device_id"] = @(receiver.device); report[@"stream_id"] = @(receiver.stream);
        report[@"frames"] = @(stats.frames); report[@"expected_1280x720_bgra_frames"] = @(stats.expected);
        report[@"dimensions_and_pixel_formats"] = stats.formats;
        report[@"sampled_frames"] = @(stats.sampled); report[@"sample_limit"] = @10000;
        if (stats.pngAttempted) { report[@"diagnostic_png_saved"] = @(stats.pngSaved); report[@"diagnostic_png"] = [NSString stringWithUTF8String:stats.pngPath]; }
        report[@"pixels_sampled_per_frame"] = @(2304 + (stats.portraitFit ? 11520 : 0));
        if (stats.portraitFit) {
            report[@"portrait_fit"] = @{
                @"expected_viewport_x_bounds": @[@437.5, @842.5],
                @"expected_image_size": @[@405, @720],
                @"black_opaque_pillar_frames": @(stats.pillarFrames),
                @"center_contrast_frames": @(stats.centerContrastFrames),
                @"color_center_frames": @(stats.colorCenterFrames),
                @"fitting_contrasted_frames": @(stats.fitFrames),
                @"fitting_center_hash_changes": @(stats.fitChanges),
                @"measured_active_x_bounds_fitting_frames": stats.activeMaxX >= 0 ?
                    (id)@[@(stats.activeMinX), @(stats.activeMaxX)] : (id)[NSNull null],
                @"last_measured_active_x_bounds": stats.lastActiveMaxX >= 0 ?
                    (id)@[@(stats.lastActiveMinX), @(stats.lastActiveMaxX)] : (id)[NSNull null],
                @"sampling": @"x=0..1276 step 4, y=10..710 step 20; pillars x<=436 or x>=844 require RGB<=2 and alpha=255, including x=100/1180. Interior luma range>=24; color count uses channel range>=24 (not required).",
                @"acceptance": @"At least 3 fitting contrasted frames and 2 interior hash changes between them; transition frames allowed. Bounds are inclusive visible nonblack samples, not viewport edges; dark content can inset bounds."
            };
        }
        report[@"unique_hashes"] = @(stats.hashes.size()); report[@"hash_changes"] = @(stats.changes);
        report[@"contrast_frames"] = @(stats.contrastFrames);
        report[@"mean_luma_range"] = stats.sampled ? @(stats.contrastSum / stats.sampled) : (id)[NSNull null];
        report[@"max_luma_range"] = @(stats.maxContrast);
        report[@"mean_interval_ms"] = stats.ptsIntervals ? @(1000 * stats.ptsSum / stats.ptsIntervals) : (id)[NSNull null];
        report[@"mean_arrival_interval_ms"] = stats.frames > 1 ? @(1000 * (stats.lastArrival - stats.firstArrival) / (stats.frames - 1)) : (id)[NSNull null];
        report[@"interval_count"] = @(stats.ptsIntervals);
        report[@"invalid_frames"] = @(stats.invalid); report[@"lock_errors"] = @(stats.lockErrors);
        report[@"queue_callbacks"] = @(notifications.load(std::memory_order_relaxed));
        report[@"shutdown_drained"] = @(receiver.drained);
        report[@"stop_status"] = @(receiver.stopStatus); report[@"unregister_status"] = @(receiver.unregisterStatus);
        report[@"interrupted"] = @(interrupted != 0);
        report[@"elapsed_seconds"] = @(std::chrono::duration<double>(Clock::now() - begin).count());
        report[@"limitations"] = @"Sparse RGB hash and luma contrast are diagnostic evidence, not cube recognition. Static standby can have contrast. No format negotiation, producer control, or security changes. Optional VC4M_RECEIVER_PNG writes one diagnostic frame. PTS mean includes only positive finite deltas; arrival timing includes polling jitter.";
        NSData* json = [NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys error:nil];
        if (json) { fwrite(json.bytes, 1, json.length, stdout); fputc('\n', stdout); }
        return result;
    }
}

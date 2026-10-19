// Trusted Electron main-process API only. A pointer-sized Buffer is NOT a
// capability check: an arbitrary non-null pointer can crash CFRetain. Never
// expose submit() (or forward renderer-provided handle bytes) through IPC.
#include <node_api.h>
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#import <Metal/Metal.h>

#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <memory>
#include <new>
#include <stdexcept>
#include <string>

namespace {
using Clock = std::chrono::steady_clock;

struct Work;
struct State {
  id<MTLDevice> device = nil;
  id<MTLCommandQueue> queue = nil;
  id<MTLTexture> destination = nil;
  Work* active = nullptr;
  size_t sourceRetains = 0;
  uint64_t readbackCount = 0; // Debug submissions committed, not buffer count.
  bool closing = false;
  napi_async_cleanup_hook_handle cleanup = nullptr;

  void Reset() {
    destination = nil;
    queue = nil;
    device = nil;
  }
};

struct Work {
  State* state;
  napi_env env; // Used only by destruction on the originating Node thread.
  napi_async_work async = nullptr;
  napi_deferred deferred = nullptr;
  IOSurfaceRef surface = nullptr;
  id<MTLTexture> source = nil;
  id<MTLTexture> destination = nil;
  id<MTLCommandBuffer> command = nil;
  id<MTLBuffer> sourceReadback = nil;
  id<MTLBuffer> destinationReadback = nil;
  size_t width = 0, height = 0, rowBytes = 0;
  double sequence = 0, cpuSubmitMs = 0;
  bool debug = false, rgba = false, matches = false;
  Clock::time_point entered;
  std::string error;

  Work(State* s, napi_env e) : state(s), env(e) {}

  // Also used for the exceptional commit/queue failure path and cancellation.
  // Never free a source, surface, or destination while the GPU might use it.
  void Drain() {
    if (command && command.status >= MTLCommandBufferStatusCommitted &&
        command.status < MTLCommandBufferStatusCompleted) {
      [command waitUntilCompleted];
    }
  }

  void ReleaseSource() {
    source = nil;
    if (surface) {
      CFRelease(surface);
      surface = nullptr;
      --state->sourceRetains;
    }
  }

  ~Work() {
    Drain();
    if (async) napi_delete_async_work(env, async);
    ReleaseSource();
    if (state->active == this) state->active = nullptr;
  }
};

void Check(napi_status status) {
  if (status != napi_ok) throw std::runtime_error("Node-API operation failed");
}

void Require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

napi_value String(napi_env env, const char* text) {
  napi_value value;
  Check(napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value));
  return value;
}

napi_value Number(napi_env env, double number) {
  napi_value value;
  Check(napi_create_double(env, number, &value));
  return value;
}

void Set(napi_env env, napi_value object, const char* name, napi_value value) {
  Check(napi_set_named_property(env, object, name, value));
}

void Throw(napi_env env, const char* message) {
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (!pending) napi_throw_error(env, nullptr, message);
}

napi_value ErrorValue(napi_env env, const char* message) {
  // Preserve pending exceptions (e.g. Buffer allocation failure) for rejection.
  napi_value value = nullptr;
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (pending && napi_get_and_clear_last_exception(env, &value) == napi_ok) return value;
  napi_value text;
  if (napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &text) != napi_ok) return nullptr;
  if (napi_create_error(env, nullptr, text, &value) != napi_ok) return nullptr;
  return value;
}

State* GetState(napi_env env, napi_callback_info info,
                size_t* argc = nullptr, napi_value* argv = nullptr) {
  void* data = nullptr;
  Check(napi_get_cb_info(env, info, argc, argv, nullptr, &data));
  auto* state = static_cast<State*>(data);
  Require(state && !state->closing, "Bridge environment is closing");
  return state;
}

double FiniteNumber(napi_env env, napi_value value) {
  double number;
  Check(napi_get_value_double(env, value, &number));
  Require(std::isfinite(number), "Expected a finite number");
  return number;
}

size_t Dimension(napi_env env, napi_value value) {
  double number = FiniteNumber(env, value);
  // Metal's maximum 2D dimension on supported macOS GPUs is at most 16384.
  Require(number >= 1 && number <= 16384 && std::floor(number) == number,
          "width and height must be integers in [1, 16384]");
  return static_cast<size_t>(number);
}

double Elapsed(Clock::time_point start) {
  return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}

void ValidateSurface(Work& w) {
  Require(IOSurfaceGetWidth(w.surface) == w.width &&
          IOSurfaceGetHeight(w.surface) == w.height,
          "IOSurface dimensions do not match submitted metadata");
  const uint32_t expected = w.rgba ? 0x52474241u : 0x42475241u; // RGBA / BGRA
  Require(IOSurfaceGetPixelFormat(w.surface) == expected,
          "IOSurface must be BGRA/RGBA matching pixelFormat (no YUV/sRGB aliases)");
  Require(IOSurfaceGetBytesPerElement(w.surface) == 4 &&
          IOSurfaceGetElementWidth(w.surface) == 1 &&
          IOSurfaceGetElementHeight(w.surface) == 1,
          "IOSurface must contain uncompressed four-byte pixels");
  // Electron's packed formats are non-planar. Do not accidentally import YUV
  // plane 0, or accept inconsistent per-plane/global layout descriptions.
  Require(IOSurfaceGetPlaneCount(w.surface) == 0,
          "Only non-planar packed IOSurfaces are supported");
  size_t stride = IOSurfaceGetBytesPerRow(w.surface);
  Require(stride >= w.width * 4 && stride % 4 == 0 &&
          stride <= std::numeric_limits<size_t>::max() / w.height &&
          IOSurfaceGetAllocSize(w.surface) >= stride * w.height,
          "IOSurface row stride/allocation is inconsistent with dimensions");
}

void WaitForGPU(napi_env, void* data) {
  auto& w = *static_cast<Work*>(data);
  @autoreleasepool {
    @try {
      [w.command waitUntilCompleted]; // libuv worker; no N-API/JS here.
      if (w.command.status != MTLCommandBufferStatusCompleted) return;
      if (w.debug) {
        const auto* source = static_cast<const uint8_t*>(w.sourceReadback.contents);
        const auto* destination = static_cast<const uint8_t*>(w.destinationReadback.contents);
        w.matches = true;
        // Compare only actual pixels: Metal need not initialize row padding.
        for (size_t y = 0; y < w.height; ++y) {
          if (std::memcmp(source + y * w.rowBytes,
                          destination + y * w.rowBytes, w.width * 4) != 0) {
            w.matches = false;
            break;
          }
        }
      }
    } @catch (NSException* exception) {
      w.error = exception.reason.UTF8String ?: "Metal wait failed";
    }
  }
}

napi_value Result(napi_env env, Work& w) {
  napi_value result;
  Check(napi_create_object(env, &result));
  Set(env, result, "sequence", Number(env, w.sequence));
  Set(env, result, "width", Number(env, w.width));
  Set(env, result, "height", Number(env, w.height));
  Set(env, result, "cpuSubmitMs", Number(env, w.cpuSubmitMs));
  double start = w.command.GPUStartTime, end = w.command.GPUEndTime;
  napi_value gpu;
  if (std::isfinite(start) && std::isfinite(end) && start > 0 && end >= start) {
    gpu = Number(env, (end - start) * 1000.0);
  } else {
    Check(napi_get_null(env, &gpu));
  }
  Set(env, result, "gpuMs", gpu);
  if (w.debug) {
    napi_value output, matches;
    void* bytes = nullptr;
    Check(napi_create_buffer(env, w.width * w.height * 4, &bytes, &output));
    auto* out = static_cast<uint8_t*>(bytes);
    const auto* in = static_cast<const uint8_t*>(w.destinationReadback.contents);
    for (size_t y = 0; y < w.height; ++y) {
      const uint8_t* row = in + y * w.rowBytes;
      uint8_t* target = out + y * w.width * 4;
      if (!w.rgba) {
        std::memcpy(target, row, w.width * 4);
      } else {
        // Blit preserves RGBA bytes. Convert only this optional CPU debug copy.
        for (size_t x = 0; x < w.width; ++x) {
          target[x * 4] = row[x * 4 + 2];
          target[x * 4 + 1] = row[x * 4 + 1];
          target[x * 4 + 2] = row[x * 4];
          target[x * 4 + 3] = row[x * 4 + 3];
        }
      }
    }
    Set(env, result, "outputBGRA", output);
    Check(napi_get_boolean(env, w.matches, &matches));
    Set(env, result, "sourceMatchesOutput", matches);
  }
  // Includes optional debug Buffer creation; as close to settlement as possible.
  Set(env, result, "nativeLatencyMs", Number(env, Elapsed(w.entered)));
  return result;
}

void FinishCleanup(State* state) {
  auto handle = state->cleanup;
  state->Reset();
  delete state;
  napi_remove_async_cleanup_hook(handle);
}

void Complete(napi_env env, napi_status status, void* data) {
  @autoreleasepool {
    std::unique_ptr<Work> w(static_cast<Work*>(data));
    State* state = w->state;
    napi_deferred deferred = w->deferred;
    napi_value value = nullptr;
    bool success = false;
    @try {
      try {
        // Normally already completed. If Node cancels work during teardown,
        // draining here is necessary even if the execute callback never ran.
        w->Drain();
        if (!state->closing) {
          Require(status == napi_ok, "Native async work was cancelled");
          Require(w->error.empty(), w->error.c_str());
          if (w->command.status != MTLCommandBufferStatusCompleted) {
            const char* reason = w->command.error.localizedDescription.UTF8String;
            throw std::runtime_error(reason ?: "Metal command failed");
          }
          value = Result(env, *w);
          success = true;
        }
      } catch (const std::exception& error) {
        if (!state->closing) value = ErrorValue(env, error.what());
      }
    } @catch (NSException* exception) {
      if (!state->closing) value = ErrorValue(env, exception.reason.UTF8String ?: "Metal completion failed");
    }
    // Destroy the command, imported texture, explicit CF retain, and debug
    // buffers before promise settlement (whose hooks can reenter this addon).
    // Only the State-owned private destination survives until shutdown.
    w.reset();
    if (state->closing) {
      FinishCleanup(state);
      return;
    }
    if (value) {
      napi_status settled = success ? napi_resolve_deferred(env, deferred, value)
                                    : napi_reject_deferred(env, deferred, value);
      if (settled != napi_ok) Throw(env, "Could not settle native promise");
    } else {
      Throw(env, "Could not allocate native promise result/error");
    }
  }
}

void Cleanup(napi_async_cleanup_hook_handle, void* data) {
  @autoreleasepool {
    auto* state = static_cast<State*>(data);
    state->closing = true;
    // Do not cancel queued work: it must still drain the committed GPU command.
    // The asynchronous environment cleanup hook keeps state/env alive through
    // Complete(), which skips all JS while closing and removes the hook last.
    if (!state->active) FinishCleanup(state);
  }
}

napi_value Initialize(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    @try {
      try {
        State* state = GetState(env, info);
        Require(!state->active, "Bridge is busy");
        if (!state->device) {
          id<MTLDevice> device = MTLCreateSystemDefaultDevice();
          Require(device != nil, "No Metal device available");
          id<MTLCommandQueue> queue = [device newCommandQueue];
          Require(queue != nil, "Could not create Metal command queue");
          state->device = device;
          state->queue = queue;
        }
        napi_value result;
        Check(napi_create_object(env, &result));
        Set(env, result, "device", String(env, state->device.name.UTF8String ?: "Metal"));
        return result;
      } catch (const std::exception& error) { Throw(env, error.what()); }
    } @catch (NSException* exception) { Throw(env, exception.reason.UTF8String ?: "Metal initialization failed"); }
    return nullptr;
  }
}

napi_value Submit(napi_env env, napi_callback_info info) {
  const auto entered = Clock::now();
  @autoreleasepool {
    @try {
      try {
        size_t argc = 7;
        napi_value args[7];
        State* state = GetState(env, info, &argc, args);
        Require(!state->active, "Bridge is busy: only one submit may be in flight");
        Require(state->device != nil, "Call initialize() before submit()");
        Require(argc == 6, "submit requires exactly six arguments");
        auto w = std::make_unique<Work>(state, env);
        // Reserve before napi_create_async_work: async_hooks init callbacks can
        // reenter this addon synchronously. The Work destructor rolls this back.
        state->active = w.get();
        w->entered = entered;
        w->width = Dimension(env, args[1]);
        w->height = Dimension(env, args[2]);
        char format[5] = {};
        size_t length = 0;
        Check(napi_get_value_string_utf8(env, args[3], nullptr, 0, &length));
        Require(length == 4, "pixelFormat must be 'bgra' or 'rgba'");
        Check(napi_get_value_string_utf8(env, args[3], format, sizeof(format), &length));
        Require(length == 4 && (std::strcmp(format, "bgra") == 0 ||
                               std::strcmp(format, "rgba") == 0),
                "pixelFormat must be 'bgra' or 'rgba'");
        w->rgba = std::strcmp(format, "rgba") == 0;
        w->sequence = FiniteNumber(env, args[4]);
        Check(napi_get_value_bool(env, args[5], &w->debug));
        bool isBuffer = false;
        Check(napi_is_buffer(env, args[0], &isBuffer));
        Require(isBuffer, "ioSurfaceBuffer must be a Buffer containing a local IOSurfaceRef");
        void* bytes = nullptr;
        size_t byteLength = 0;
        Check(napi_get_buffer_info(env, args[0], &bytes, &byteLength));
        Require(byteLength == sizeof(IOSurfaceRef), "ioSurfaceBuffer must be exactly sizeof(IOSurfaceRef)");
        IOSurfaceRef surface = nullptr;
        std::memcpy(&surface, bytes, sizeof(surface)); // Buffer need not be aligned.
        Require(surface != nullptr, "IOSurfaceRef must not be null");
        // Synchronous retain before returning to JS. This assumes trusted,
        // process-local Electron handle bytes; arbitrary pointers are NOT safe.
        CFRetain(surface);
        w->surface = surface;
        ++state->sourceRetains;
        ValidateSurface(*w);
        MTLPixelFormat pixelFormat = w->rgba ? MTLPixelFormatRGBA8Unorm : MTLPixelFormatBGRA8Unorm;
        if (state->destination) {
          Require(state->destination.width == w->width &&
                  state->destination.height == w->height &&
                  state->destination.pixelFormat == pixelFormat,
                  "Dimensions/pixelFormat are fixed until idle shutdown() and initialize()");
        }
        MTLTextureDescriptor* descriptor = [MTLTextureDescriptor
            texture2DDescriptorWithPixelFormat:pixelFormat width:w->width height:w->height mipmapped:NO];
        descriptor.storageMode = MTLStorageModeShared;
        descriptor.usage = MTLTextureUsageShaderRead;
        // Import every event, never cache the producer's texture/pointer.
        w->source = [state->device newTextureWithDescriptor:descriptor iosurface:surface plane:0];
        Require(w->source != nil, "Metal could not import the IOSurface");
        Require(w->source.width == w->width && w->source.height == w->height &&
                w->source.pixelFormat == pixelFormat, "Imported Metal texture metadata mismatch");
        if (!state->destination) {
          descriptor.storageMode = MTLStorageModePrivate;
          state->destination = [state->device newTextureWithDescriptor:descriptor];
          Require(state->destination != nil, "Could not allocate private destination texture");
        }
        w->destination = state->destination;
        if (w->debug) {
          // 256-byte row alignment works for both supported four-byte formats
          // and Intel/Apple Silicon texture-to-buffer blits. No CPU surface lock.
          w->rowBytes = (w->width * 4 + 255) & ~size_t(255);
          const size_t count = w->rowBytes * w->height;
          Require(count <= state->device.maxBufferLength, "Debug readback exceeds Metal buffer limit");
          w->sourceReadback = [state->device newBufferWithLength:count options:MTLResourceStorageModeShared];
          w->destinationReadback = [state->device newBufferWithLength:count options:MTLResourceStorageModeShared];
          Require(w->sourceReadback && w->destinationReadback, "Could not allocate debug readback buffers");
        }
        w->command = [state->queue commandBuffer];
        Require(w->command != nil, "Could not allocate Metal command buffer");
        id<MTLBlitCommandEncoder> blit = [w->command blitCommandEncoder];
        Require(blit != nil, "Could not create Metal blit encoder");
        const MTLSize size = MTLSizeMake(w->width, w->height, 1);
        const MTLOrigin origin = MTLOriginMake(0, 0, 0);
        [blit copyFromTexture:w->source sourceSlice:0 sourceLevel:0 sourceOrigin:origin
                   sourceSize:size toTexture:w->destination destinationSlice:0
                   destinationLevel:0 destinationOrigin:origin];
        if (w->debug) {
          [blit copyFromTexture:w->source sourceSlice:0 sourceLevel:0 sourceOrigin:origin
                     sourceSize:size toBuffer:w->sourceReadback destinationOffset:0
                     destinationBytesPerRow:w->rowBytes destinationBytesPerImage:w->rowBytes * w->height];
          [blit copyFromTexture:w->destination sourceSlice:0 sourceLevel:0 sourceOrigin:origin
                     sourceSize:size toBuffer:w->destinationReadback destinationOffset:0
                     destinationBytesPerRow:w->rowBytes destinationBytesPerImage:w->rowBytes * w->height];
        }
        [blit endEncoding];
        napi_value promise;
        Check(napi_create_promise(env, &w->deferred, &promise));
        Check(napi_create_async_work(env, nullptr, String(env, "IOSurface Metal blit"),
                                     WaitForGPU, Complete, w.get(), &w->async));
        // Work's destructor drains and deletes async work if commit/queue
        // fails. Only this exceptional path can wait on the Node thread.
        [w->command commit];
        w->cpuSubmitMs = Elapsed(entered);
        if (w->debug) ++state->readbackCount;
        Check(napi_queue_async_work(env, w->async));
        state->active = w.release();
        return promise;
      } catch (const std::exception& error) { Throw(env, error.what()); }
    } @catch (NSException* exception) { Throw(env, exception.reason.UTF8String ?: "Metal submission failed"); }
    return nullptr;
  }
}

napi_value Shutdown(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    try {
      State* state = GetState(env, info);
      Require(!state->active, "Bridge is busy: shutdown() requires an idle bridge");
      state->Reset();
      napi_value undefined;
      Check(napi_get_undefined(env, &undefined));
      return undefined;
    } catch (const std::exception& error) { Throw(env, error.what()); }
    return nullptr;
  }
}

napi_value Diagnostics(napi_env env, napi_callback_info info) {
  try {
    State* state = GetState(env, info);
    napi_value result;
    Check(napi_create_object(env, &result));
    Set(env, result, "inFlight", Number(env, state->active ? 1 : 0));
    Set(env, result, "sourceRetains", Number(env, state->sourceRetains));
    Set(env, result, "destinationTextures", Number(env, state->destination ? 1 : 0));
    Set(env, result, "readbackCount", Number(env, static_cast<double>(state->readbackCount)));
    return result;
  } catch (const std::exception& error) { Throw(env, error.what()); }
  return nullptr;
}
} // namespace

NAPI_MODULE_INIT() {
  try {
    auto state = std::make_unique<State>();
    napi_property_descriptor properties[] = {
      {"initialize", nullptr, Initialize, nullptr, nullptr, nullptr, napi_default, state.get()},
      {"submit", nullptr, Submit, nullptr, nullptr, nullptr, napi_default, state.get()},
      {"shutdown", nullptr, Shutdown, nullptr, nullptr, nullptr, napi_default, state.get()},
      {"diagnostics", nullptr, Diagnostics, nullptr, nullptr, nullptr, napi_default, state.get()}
    };
    Check(napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties));
    Check(napi_add_async_cleanup_hook(env, Cleanup, state.get(), &state->cleanup));
    state.release(); // Owned by the cleanup hook, not process-global state.
    return exports;
  } catch (const std::exception& error) { Throw(env, error.what()); }
  return nullptr;
}

// Test-only producer of valid, process-local IOSurface handles. Not linked into
// bridge.node. Build with test/binding.gyp; never use renderer-supplied pointers.
#include <node_api.h>
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#include <cstdint>
#include <cstring>

static void Release(napi_env, void* data, void*) {
  CFRelease(data);
}

static napi_value Create(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    size_t argc = 4;
    napi_value args[4];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    uint32_t width = 37, height = 19, format = 0x42475241, bpe = 4;
    if (argc > 0) napi_get_value_uint32(env, args[0], &width);
    if (argc > 1) napi_get_value_uint32(env, args[1], &height);
    if (argc > 2) napi_get_value_uint32(env, args[2], &format);
    if (argc > 3) napi_get_value_uint32(env, args[3], &bpe);
    if (!width || !height || width > 4096 || height > 4096 || (bpe != 4 && bpe != 8)) {
      napi_throw_error(env, nullptr, "Invalid fixture parameters");
      return nullptr;
    }
    NSDictionary* properties = @{
      (__bridge NSString*)kIOSurfaceWidth: @(width),
      (__bridge NSString*)kIOSurfaceHeight: @(height),
      (__bridge NSString*)kIOSurfaceBytesPerElement: @(bpe),
      (__bridge NSString*)kIOSurfacePixelFormat: @(format)
    };
    IOSurfaceRef surface = IOSurfaceCreate((__bridge CFDictionaryRef)properties);
    if (!surface) {
      napi_throw_error(env, nullptr, "IOSurfaceCreate failed");
      return nullptr;
    }
    IOSurfaceLock(surface, 0, nullptr);
    auto* base = static_cast<uint8_t*>(IOSurfaceGetBaseAddress(surface));
    const size_t stride = IOSurfaceGetBytesPerRow(surface);
    for (uint32_t y = 0; y < height; ++y) {
      for (uint32_t x = 0; x < width; ++x) {
        uint8_t* pixel = base + y * stride + x * bpe;
        pixel[0] = (x * 7 + y * 3) % 256;
        pixel[1] = (x + y * 11) % 256;
        pixel[2] = (x * 13 + y) % 256;
        pixel[3] = 255;
      }
    }
    IOSurfaceUnlock(surface, 0, nullptr);
    // Allocate inside the runtime: Electron's V8 sandbox forbids external
    // Buffers, even though regular Node accepts napi_create_external_buffer.
    void* bytes = nullptr;
    napi_value handle;
    if (napi_create_buffer(env, sizeof(surface), &bytes, &handle) != napi_ok ||
        napi_add_finalizer(env, handle, surface, Release, nullptr, nullptr) != napi_ok) {
      CFRelease(surface);
      napi_throw_error(env, nullptr, "Could not allocate fixture handle");
      return nullptr;
    }
    std::memcpy(bytes, &surface, sizeof(surface));
    return handle;
  }
}

NAPI_MODULE_INIT() {
  napi_value create;
  napi_create_function(env, "create", NAPI_AUTO_LENGTH, Create, nullptr, &create);
  napi_set_named_property(env, exports, "create", create);
  return exports;
}

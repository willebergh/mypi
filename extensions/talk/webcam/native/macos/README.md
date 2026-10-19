# Native Metal bridge

`bridge.mm` is a raw Node-API v8 addon (Objective-C++, ARC, C++17). It links Foundation, IOSurface and Metal. No Swift, V8 API, or native helper process. The same binary loads in the build-host Node and Electron via Node-API's stable ABI; it must match the host CPU architecture.

## Build / API

Install Xcode or its Command Line Tools, Python 3 and pnpm dependencies. `pnpm native:build` runs node-gyp. Forge's `generateAssets` hook builds it automatically for `pnpm dev`, `pnpm verify` and `pnpm package`. The host architecture is the only supported native packaging target for now. node-gyp may download Node headers on the first build.

The packaged `.node` is copied to `Contents/Resources/bridge.node` **outside app.asar**. No native code is loaded into the sandboxed UI or output renderer.

- `initialize()` → Metal device name.
- `submit(handleBuffer, width, height, pixelFormat, sequence, debugReadback)` → Promise of timing and sequence metadata. Debug submissions also return tightly-packed BGRA bytes and a same-frame source/destination comparison.
- `diagnostics()` → current in-flight work, explicit source retain count, owned destination texture count, cumulative debug-readback submissions.
- `shutdown()` → destroys destination, command queue and device references, and requires no work in flight.

The handle Buffer contains **one process-local `IOSurfaceRef` pointer**, not pixel bytes, not a surface ID, and not an IPC-safe pointer. Only trusted Electron main-process metadata may reach `submit`. Size and format checks cannot make an arbitrary pointer safe to dereference. This addon is never exposed over preload IPC.

## Frame ownership / synchronization

1. Main receives `paint.texture`, keeps that JS object and its release callback, and submits its native handle. It admits **one** job, with **zero** queued frames. A frame arriving while busy is dropped and immediately released.
2. Native code extracts the pointer with `memcpy`, synchronously `CFRetain`s the IOSurface, validates dimensions/stride/allocation/packed pixel format, and imports a fresh Metal texture for each event. Producer imports are not cached; Electron can deliver different pooled surfaces.
3. A Metal blit copies the imported source into one bridge-owned **private GPU texture**. The destination is reused only when the prior job has completed. Continuous submissions do not lock/map the IOSurface, allocate JS pixel buffers, or call `getBytes`/`capturePage`.
4. The command is committed on the calling thread. A Node async-work worker waits for completion without blocking the Electron event loop. The native source texture and explicit surface retain stay alive until completion. A normal successful result means Metal reports `Completed`, not merely `Scheduled`.
5. Native cleanup releases the source before resolving/rejecting the Promise. Only then does the main-process Promise finalizer call **Electron `texture.release()`**, allowing Chromium to reuse its frame-pool slot. A CoreFoundation retain alone would not stop Chromium from overwriting the pixels.
6. Stop first calls `stopPainting`, stops admission, awaits the outstanding job and Electron release, shuts down the native destination/queue, and **then destroys the output window**. Quit follows the same async drain. Async N-API environment cleanup also drains committed work before freeing native state. Failure paths after commit must drain as well.

Electron documents producer-side GPU completion before delivering a shared capture; this milestone relies on that contract. It does not invent or transfer a producer fence. Destination reuse is serialized by the one-job bound. A future independently running consumer needs its own completion/reuse protocol.

Only packed `bgra`/`rgba` unorm textures are supported. Dimensions/format are fixed for a session and can change after an idle shutdown/reinitialize. HDR, YUV/NV12, crop/scale and color conversion are out of scope.

## Verification and measurement

`pnpm verify` exercises actual Electron-rendered cube frames. Its two debug submissions append GPU blits of **both the imported source and private destination** into separate shared Metal buffers, after the source→destination copy. CPU access occurs only after the command completes. Pixel rows are compared exactly (padding excluded), then only destination pixels are returned to JS and saved as `artifacts/native-metal-1.png` / `native-metal-2.png`. Preserved imported images are in `../../docs/evidence/native-metal-1.png` and `../../docs/evidence/native-metal-2.png`; new runs still write to `artifacts/`. Distinct frame sequence numbers and pixel hashes prove animation. The verifier also checks cube-center/background contrast and compares native source/destination bytes for each frame. Debug copies are not used in baseline/overhead intervals or continuous-operation intervals.

- **CPU submission:** monotonic wall-clock time in the native call from entry through validation/import/encoding/commit. Includes N-API setup, not a CPU-cycle counter or pure Metal-driver-only cost.
- **GPU operation:** actual `MTLCommandBuffer.GPUStartTime`→`GPUEndTime`, queried only after completion. `null` if unavailable. Includes optional blits on debug frames; those frames are excluded from reported benchmark intervals.
- **Native latency:** native entry→result creation/settlement, including worker scheduling and main-thread callback scheduling.
- **Completion latency:** JS paint-handler submission→resolved native callback. This is **not** Three.js animation/render→native/camera end-to-end latency. Electron capture timestamps and the native clock are not assumed to share an origin.
- **CPU usage:** verifier measures Electron main-process `process.cpuUsage()` over wall time (100% = one logical core); this includes addon worker CPU but not renderer/GPU service processes. Separate Electron per-process CPU/memory metrics and RSS are saved in JSON. Sequential baseline/bridge runs are indicative comparisons, not statistically controlled benchmarks.

Unit smoke tests use independent, known-pattern IOSurfaces for validation/error/cleanup checks; these are separate from the actual cube-frame verification. See the project README for commands and measured results.

## Future CoreMediaIO process boundary (not implemented)

**Recommended:** copy Electron's texture into a small **bridge-owned IOSurface-backed output pool**, then transfer those output surfaces over an authenticated XPC connection. This decouples slow camera clients from Chromium's limited capture pool. This milestone's private destination texture is *not* exportable as an IOSurface; replace its allocation with IOSurface-backed storage when implementing that milestone. A GPU→GPU copy still avoids CPU readbacks.

1. Register each owned output slot with the receiver via `IOSurfaceCreateXPCObject`; the receiver obtains its own retained `IOSurfaceRef` with `IOSurfaceLookupFromXPCObject`. Sending raw pointer bytes, a numeric Mach-port name in JSON, or Electron's Buffer through generic Electron IPC does **not** transfer a valid reference to an external process.
2. Alternatively, `IOSurfaceCreateMachPort` plus an actual Mach message/XPC Mach-send-right transfer is suitable. Account explicitly for copy/move-send dispositions; deallocate each locally owned right with `mach_port_deallocate`. `IOSurfaceLookupFromMachPort` returns a retained surface and does **not** destroy the port. XPC-created objects also hold surface references until released.
3. Do not publish globally discoverable IOSurface IDs. Authenticate peers using service policy/audit tokens/code identity as appropriate; validate formats, dimensions, plane layouts, allocation limits and message bounds. App Group/system-extension entitlements and the allowed app↔extension connection topology need validation in a real signed extension prototype; ordinary arbitrary service access must not be assumed.
4. Signal `{slot, generation, sequence, timing}` as ready **only after the producer GPU write completes**. IOSurface transport shares storage, not a fence or a no-overwrite guarantee. Initially use completion callbacks and explicit release acknowledgements. Shared Metal events/fences can be investigated later, but do not assume in-process fences work cross-process.
5. Receiver wraps its local surface in `CVPixelBufferCreateWithIOSurface`, creates the corresponding format description / timed `CMSampleBuffer`, and supplies it through the CMIO extension stream API. Pixel format/color metadata must be negotiated; BGRA is not automatically the final camera format.
6. Reuse a slot only after all relevant consumers are done with GPU reads and framework ownership. Acknowledging XPC receipt or even returning from a CMIO send call is **not** proof that downstream clients have finished. Tie reuse to the eventual CVPixelBuffer/IOSurface pool lifetime semantics and verify those semantics against the extension API. Bound outstanding slots, drop when exhausted, and handle generations/disconnects. On a timeout do **not** simply overwrite storage a live peer may still use—retire/quarantine it until ownership is safely reclaimed.

Directly exporting Electron's *source* surface could technically work with proper rights transfer, but requires keeping Electron's frame unreleased until remote consumption finishes and risks exhausting Chromium's frame pool. It is not the recommended first camera implementation.

## References reviewed

- [Electron 44.9 OSR frame lifecycle and native pointer handling](https://github.com/electron/electron/blob/v44.9.0/shell/browser/osr/README.md)
- [Electron SharedTextureHandle (`ioSurface` is local)](https://www.electronjs.org/docs/latest/api/structures/shared-texture-handle)
- [Electron release contract](https://www.electronjs.org/docs/latest/api/structures/offscreen-shared-texture)
- [Metal import from IOSurface](https://developer.apple.com/documentation/metal/mtldevice/maketexture(descriptor:iosurface:plane:))
- [Metal GPUStartTime](https://developer.apple.com/documentation/metal/mtlcommandbuffer/gpustarttime)
- [IOSurfaceCreateXPCObject](https://developer.apple.com/documentation/iosurface/iosurfacecreatexpcobject(_:)) / [lookup](https://developer.apple.com/documentation/iosurface/iosurfacelookupfromxpcobject(_:))
- [IOSurfaceCreateMachPort](https://developer.apple.com/documentation/iosurface/iosurfacecreatemachport(_:)) / [lookup](https://developer.apple.com/documentation/iosurface/iosurfacelookupfrommachport(_:))
- [CVPixelBufferCreateWithIOSurface](https://developer.apple.com/documentation/corevideo/cvpixelbuffercreatewithiosurface(_:_:_:_:))
- [Creating a camera extension](https://developer.apple.com/documentation/coremediaio/creating-a-camera-extension-with-core-media-i-o)

XPC reference ownership and Mach-port cleanup were also checked against the installed macOS SDK's `IOSurfaceAPI.h` and `IOSurfaceRef.h` comments.

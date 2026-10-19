// Trusted Electron main process ONLY: handle is a process-local IOSurfaceRef,
// not an IOSurface ID or an IPC-safe capability. Never expose this API to IPC.
#include <node_api.h>
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <IOSurface/IOSurface.h>
#import <CoreMediaIO/CoreMediaIO.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#include <chrono>
#include <cmath>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
#include "gpu-fit.h"

namespace {
using Clock = std::chrono::steady_clock;
NSString* const UID = @"B9E1C0F2-6A2E-4B7D-9C3A-2F1E7D4A5C6B";
void Require(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
void Check(napi_status s) { Require(s == napi_ok, "Node-API failure"); }
void OSCheck(OSStatus s, const char* op) {
  if (s) throw std::runtime_error(std::string(op) + " OSStatus=" + std::to_string(s));
}
CMIOObjectPropertyAddress Address(UInt32 selector) {
  return {selector, kCMIOObjectPropertyScopeGlobal, kCMIOObjectPropertyElementMain};
}
template<class T> T Property(CMIOObjectID object, UInt32 selector) {
  auto a = Address(selector); T value{}; UInt32 used=0;
  OSCheck(CMIOObjectGetPropertyData(object,&a,0,nullptr,sizeof(value),&used,&value),"CMIO property");
  Require(used == sizeof(value), "Unexpected CMIO property size"); return value;
}
std::vector<CMIOObjectID> Objects(CMIOObjectID object, UInt32 selector) {
  auto a=Address(selector); UInt32 size=0,used=0;
  OSCheck(CMIOObjectGetPropertyDataSize(object,&a,0,nullptr,&size),"CMIO list size");
  Require(size % sizeof(CMIOObjectID) == 0, "Invalid CMIO list size");
  std::vector<CMIOObjectID> list(size/sizeof(CMIOObjectID));
  if (size) OSCheck(CMIOObjectGetPropertyData(object,&a,0,nullptr,size,&used,list.data()),"CMIO list");
  Require(used<=size && used%sizeof(CMIOObjectID)==0,"CMIO list changed; retry discovery");
  list.resize(used/sizeof(CMIOObjectID)); return list;
}
bool Matches(CMIOObjectID device) {
  CFStringRef uid = Property<CFStringRef>(device,kCMIODevicePropertyDeviceUID);
  bool match = uid && [(__bridge NSString*)uid caseInsensitiveCompare:UID] == NSOrderedSame;
  if (uid) CFRelease(uid); return match;
}
struct Found { CMIOObjectID device=0; CMIOStreamID stream=0; };
Found Discover() {
  for (auto device : Objects(kCMIOObjectSystemObject,kCMIOHardwarePropertyDevices)) {
    if (!Matches(device)) continue;
    Found found{device,0};
    for (auto stream : Objects(device,kCMIODevicePropertyStreams)) {
      // CMIO direction: 0 = output (producer writes), 1 = input (camera reads).
      if (Property<UInt32>(stream,kCMIOStreamPropertyDirection)==0) {
        Require(found.stream==0,"Multiple output streams; refusing ambiguous sink"); found.stream=stream;
      }
    }
    Require(found.stream!=0,"VirtualCamera4Mac has no sink stream"); return found;
  }
  return {};
}
// Process-lifetime no-op: safe even if a callback races stream teardown.
void QueueChanged(CMIOStreamID, void*, void*) {}
struct Work;
struct State {
  Found found;
  CMSimpleQueueRef buffers=nullptr;
  id<MTLDevice> metal=nil;
  id<MTLCommandQueue> commands=nil;
  id<MTLRenderPipelineState> fitPipeline=nil;
  Work* active=nullptr;
  size_t sourceWidth=0,sourceHeight=0;
  bool started=false,closing=false;
  uint64_t accepted=0,dropped=0,allocated=0;
  std::string error;
  napi_async_cleanup_hook_handle cleanup=nullptr;
  bool Alive() {
    if (!found.device) return false;
    try { return Property<UInt32>(found.device,kCMIODevicePropertyDeviceIsAlive)!=0 && Matches(found.device); }
    catch (...) { return false; }
  }
  void Stop() {
    if (started) {
      OSStatus status=CMIODeviceStopStream(found.device,found.stream);
      if(status) error="CMIODeviceStopStream OSStatus="+std::to_string(status);
      else started=false;
    }
  }
  void Disconnect() {
    Stop();
    // Unregister the process-lifetime callback (it never accesses State).
    if (buffers) {
      CMSimpleQueueRef extra=nullptr;
      OSStatus status=CMIOStreamCopyBufferQueue(found.stream,nullptr,nullptr,&extra);
      if(status) error="Unregister sink queue OSStatus="+std::to_string(status);
      if(extra) CFRelease(extra);
    }
    // Successfully enqueued sample +1s belong to CMIO, even on removal; never
    // manually drain an output queue concurrently with its transport consumer.
    if (buffers) { CFRelease(buffers); buffers=nullptr; }
    fitPipeline=nil; commands=nil; metal=nil; found={}; started=false;
    sourceWidth=0; sourceHeight=0;
  }
};
struct Work {
  State* state; napi_env env; napi_async_work async=nullptr; napi_deferred deferred=nullptr;
  IOSurfaceRef sourceSurface=nullptr;
  CVPixelBufferRef output=nullptr;
  id<MTLTexture> source=nil,destination=nil;
  id<MTLCommandBuffer> command=nil;
  CMTime pts=kCMTimeInvalid;
  Clock::time_point entered=Clock::now();
  double sequence=0,submitMs=0;
  size_t width=0,height=0;
  bool waitException=false;
  Work(State* s,napi_env e):state(s),env(e) {}
  void Drain() noexcept {
    // A failed wait is not GPU completion. Retry until terminal status, keeping
    // both our retain and the JS/Electron release pending. Fail closed rather
    // than ever releasing potentially busy producer storage.
    while(command) {
      @try {
        auto status=command.status;
        if(status<MTLCommandBufferStatusCommitted || status>=MTLCommandBufferStatusCompleted) return;
        [command waitUntilCompleted];
      } @catch(NSException*) {
        waitException=true;
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
      }
    }
  }
  ~Work() {
    Drain(); source=nil; destination=nil;
    if (sourceSurface) CFRelease(sourceSurface);
    if (output) CVPixelBufferRelease(output);
    if (async) napi_delete_async_work(env,async);
    if (state->active==this) state->active=nullptr;
  }
};
napi_value String(napi_env env,const char* text) { napi_value v; Check(napi_create_string_utf8(env,text,NAPI_AUTO_LENGTH,&v)); return v; }
napi_value Number(napi_env env,double n) { napi_value v; Check(napi_create_double(env,n,&v)); return v; }
napi_value Bool(napi_env env,bool b) { napi_value v; Check(napi_get_boolean(env,b,&v)); return v; }
void Set(napi_env env,napi_value v,const char* key,napi_value data) { Check(napi_set_named_property(env,v,key,data)); }
napi_value Object(napi_env env) { napi_value v; Check(napi_create_object(env,&v)); return v; }
napi_value Undefined(napi_env env) { napi_value v; Check(napi_get_undefined(env,&v)); return v; }
void Throw(napi_env env,const char* message) {
  bool pending=false; napi_is_exception_pending(env,&pending); if(!pending) napi_throw_error(env,nullptr,message);
}
State* Get(napi_env env,napi_callback_info info,size_t* argc=nullptr,napi_value* args=nullptr) {
  void* data=nullptr; Check(napi_get_cb_info(env,info,argc,args,nullptr,&data));
  auto* s=static_cast<State*>(data); Require(s && !s->closing,"Producer environment closing"); return s;
}
double Finite(napi_env env,napi_value v) { double n; Check(napi_get_value_double(env,v,&n)); Require(std::isfinite(n),"Expected finite number"); return n; }
double Ms(Clock::time_point t) { return std::chrono::duration<double,std::milli>(Clock::now()-t).count(); }
napi_value Snapshot(napi_env env,State& s) {
  napi_value v=Object(env);
  const bool alive=s.buffers && s.Alive();
  Set(env,v,"connected",Bool(env,alive)); Set(env,v,"publishing",Bool(env,s.started && alive));
  Set(env,v,"inFlight",Number(env,s.active?1:0)); Set(env,v,"accepted",Number(env,s.accepted));
  Set(env,v,"dropped",Number(env,s.dropped)); Set(env,v,"allocatedSurfaces",Number(env,s.allocated));
  Set(env,v,"device",Number(env,s.found.device)); Set(env,v,"sink",Number(env,s.found.stream));
  Set(env,v,"sourceWidth",Number(env,s.sourceWidth)); Set(env,v,"sourceHeight",Number(env,s.sourceHeight));
  Set(env,v,"outputWidth",Number(env,1280)); Set(env,v,"outputHeight",Number(env,720));
  Set(env,v,"scaleMode",String(env,"aspect-fit"));
  Set(env,v,"error",String(env,s.error.c_str())); return v;
}
void FinishCleanup(State* s) { auto hook=s->cleanup; s->Disconnect(); delete s; napi_remove_async_cleanup_hook(hook); }
void Execute(napi_env,void* data) { @autoreleasepool { static_cast<Work*>(data)->Drain(); } }
void Complete(napi_env env,napi_status status,void* data) {
  @autoreleasepool {
    std::unique_ptr<Work> w(static_cast<Work*>(data)); State* s=w->state;
    napi_deferred deferred=w->deferred; napi_value result=nullptr; bool success=false;
    @try { try {
      w->Drain();
      if (!s->closing) {
        Require(status==napi_ok,"GPU wait cancelled");
        Require(!w->waitException,"Metal wait raised an exception (GPU drained safely)");
        Require(w->command.status==MTLCommandBufferStatusCompleted,"Metal command failed");
        Require(s->started && s->Alive(),"VirtualCamera4Mac disconnected during GPU transfer");
        bool accepted=false;
        if (CMSimpleQueueGetCount(s->buffers)<CMSimpleQueueGetCapacity(s->buffers)) {
          CMVideoFormatDescriptionRef format=nullptr; CMSampleBufferRef sample=nullptr;
          OSStatus err=CMVideoFormatDescriptionCreateForImageBuffer(kCFAllocatorDefault,w->output,&format);
          if (!err) {
            CMSampleTimingInfo timing{CMTimeMake(1,30),w->pts,kCMTimeInvalid};
            err=CMSampleBufferCreateForImageBuffer(kCFAllocatorDefault,w->output,true,nullptr,nullptr,format,&timing,&sample);
          }
          if(format) CFRelease(format);
          OSCheck(err,"Create camera sample");
          // Transfer the create-rule +1 to CMIO. CMSimpleQueue itself does not
          // retain; on enqueue failure ownership stays here and is released.
          err=CMSimpleQueueEnqueue(s->buffers,sample);
          if(err) {
            CFRelease(sample);
            if(err!=kCMSimpleQueueError_QueueIsFull) OSCheck(err,"Enqueue sink sample");
          } else accepted=true;
        }
        if(accepted) ++s->accepted; else ++s->dropped;
        result=Object(env); Set(env,result,"accepted",Bool(env,accepted));
        Set(env,result,"sequence",Number(env,w->sequence));
        Set(env,result,"cpuSubmitMs",Number(env,w->submitMs));
        double start=w->command.GPUStartTime,end=w->command.GPUEndTime;
        if(std::isfinite(start) && std::isfinite(end) && start>0 && end>=start)
          Set(env,result,"gpuMs",Number(env,(end-start)*1000));
        else { napi_value nullValue; Check(napi_get_null(env,&nullValue)); Set(env,result,"gpuMs",nullValue); }
        Set(env,result,"nativeLatencyMs",Number(env,Ms(w->entered))); success=true;
      }
    } catch(const std::exception& e) { s->error=e.what(); }
    } @catch(NSException* e) { s->error=e.reason.UTF8String ?: "Objective-C completion exception"; }
    if (!success && !s->closing) {
      bool pending=false; napi_is_exception_pending(env,&pending);
      if(pending) napi_get_and_clear_last_exception(env,&result);
      else napi_create_error(env,nullptr,String(env,s->error.c_str()),&result);
    }
    w.reset(); // GPU imports released before JS releases Electron's texture.
    if(s->closing) { FinishCleanup(s); return; }
    if(result) {
      napi_status settled=success?napi_resolve_deferred(env,deferred,result):napi_reject_deferred(env,deferred,result);
      if(settled!=napi_ok) Throw(env,"Could not settle producer promise");
    } else Throw(env,"Could not allocate completion result");
  }
}
void Cleanup(napi_async_cleanup_hook_handle,void* data) {
  @autoreleasepool { auto* s=static_cast<State*>(data); s->closing=true; if(!s->active) FinishCleanup(s); }
}
// Guard all native entrypoints, including ObjC/Metal exceptions.
template<napi_value (*Fn)(napi_env,napi_callback_info)> napi_value Guard(napi_env env,napi_callback_info info) {
  @autoreleasepool { @try { try { return Fn(env,info); }
    catch(const std::exception& e) { Throw(env,e.what()); }
  } @catch(NSException* e) { Throw(env,e.reason.UTF8String ?: "Objective-C producer exception"); } return nullptr; }
}
napi_value Discovery(napi_env env,napi_callback_info) {
  Found f=Discover(); napi_value v=Object(env); Set(env,v,"available",Bool(env,f.device!=0));
  Set(env,v,"device",Number(env,f.device)); Set(env,v,"sink",Number(env,f.stream)); return v;
}
napi_value Connect(napi_env env,napi_callback_info info) {
  State* s=Get(env,info); Require(!s->active,"Producer busy");
  if(s->buffers && s->commands && s->Alive()) return Snapshot(env,*s);
  s->Disconnect(); s->error.clear(); s->found=Discover();
  Require(s->found.device!=0,"VirtualCamera4Mac not found; install and activate its camera extension");
  OSCheck(CMIOStreamCopyBufferQueue(s->found.stream,QueueChanged,nullptr,&s->buffers),"CMIOStreamCopyBufferQueue");
  Require(s->buffers && CMSimpleQueueGetCapacity(s->buffers)>0,"Sink queue unavailable");
  s->metal=MTLCreateSystemDefaultDevice(); Require(s->metal!=nil,"No Metal device");
  s->commands=[s->metal newCommandQueue]; Require(s->commands!=nil,"Metal queue unavailable");
  return Snapshot(env,*s);
}
napi_value Start(napi_env env,napi_callback_info info) {
  State* s=Get(env,info); Require(!s->active,"Producer busy"); Require(s->buffers && s->commands && s->Alive(),"Connect before start");
  if(!s->started) { OSCheck(CMIODeviceStartStream(s->found.device,s->found.stream),"CMIODeviceStartStream"); s->started=true; }
  return Snapshot(env,*s);
}
napi_value Stop(napi_env env,napi_callback_info info) { State* s=Get(env,info); Require(!s->active,"Drain submit promise before stop"); s->Stop(); return Snapshot(env,*s); }
napi_value Disconnect(napi_env env,napi_callback_info info) { State* s=Get(env,info); Require(!s->active,"Drain submit promise before disconnect"); s->Disconnect(); return Undefined(env); }
napi_value Status(napi_env env,napi_callback_info info) { return Snapshot(env,*Get(env,info)); }
napi_value Submit(napi_env env,napi_callback_info info) {
  size_t argc=6; napi_value args[6]; State* s=Get(env,info,&argc,args);
  Require(!s->active,"Producer busy: only one GPU transfer allowed");
  Require(s->started && s->Alive(),"VirtualCamera4Mac not publishing or disconnected");
  Require(argc==5,"submit(handle, width, height, pixelFormat, sequence) requires five arguments");
  auto w=std::make_unique<Work>(s,env); s->active=w.get();
  const double width=Finite(env,args[1]),height=Finite(env,args[2]);
  Require((width==1280 && height==720) || (width==720 && height==1280),
    "Source must be 1280x720 landscape or 720x1280 portrait at 30 FPS");
  w->width=static_cast<size_t>(width); w->height=static_cast<size_t>(height);
  char format[5]{}; size_t length=0;
  Check(napi_get_value_string_utf8(env,args[3],nullptr,0,&length));
  Require(length==4,"Only bgra source textures supported");
  Check(napi_get_value_string_utf8(env,args[3],format,sizeof(format),&length));
  Require(std::strcmp(format,"bgra")==0,"Only bgra source textures supported");
  w->sequence=Finite(env,args[4]); bool buffer=false; Check(napi_is_buffer(env,args[0],&buffer)); Require(buffer,"Expected local IOSurface handle Buffer");
  void* bytes=nullptr; size_t size=0; Check(napi_get_buffer_info(env,args[0],&bytes,&size));
  Require(size==sizeof(IOSurfaceRef),"Handle must be sizeof(IOSurfaceRef)");
  IOSurfaceRef surface=nullptr; std::memcpy(&surface,bytes,sizeof(surface)); Require(surface,"Null IOSurface");
  CFRetain(surface); w->sourceSurface=surface;
  Require(IOSurfaceGetWidth(surface)==w->width && IOSurfaceGetHeight(surface)==w->height,"Source dimensions mismatch");
  Require(IOSurfaceGetPixelFormat(surface)==kCVPixelFormatType_32BGRA && IOSurfaceGetPlaneCount(surface)==0 &&
    IOSurfaceGetBytesPerElement(surface)==4 && IOSurfaceGetElementWidth(surface)==1 && IOSurfaceGetElementHeight(surface)==1,
    "Source must be packed BGRA IOSurface");
  size_t stride=IOSurfaceGetBytesPerRow(surface);
  Require(stride>=w->width*4 && stride%4==0 && stride<=SIZE_MAX/w->height &&
    IOSurfaceGetAllocSize(surface)>=stride*w->height,"Invalid source stride/allocation");
  s->sourceWidth=w->width; s->sourceHeight=w->height;
  if(CMSimpleQueueGetCount(s->buffers)>=CMSimpleQueueGetCapacity(s->buffers)) {
    ++s->dropped; napi_value promise,result=Object(env); napi_deferred deferred;
    Set(env,result,"accepted",Bool(env,false)); Set(env,result,"sequence",Number(env,w->sequence));
    Check(napi_create_promise(env,&deferred,&promise)); w.reset(); Check(napi_resolve_deferred(env,deferred,result)); return promise;
  }
  w->pts=CMClockGetTime(CMClockGetHostTimeClock());
  // Deliberately allocate fresh storage, not reusable slots. Queue dequeue is
  // NOT downstream completion. CoreMediaIO retains/transports image ownership;
  // we never write this surface again, including after stop/device removal.
  // This conservative MVP avoids depending on undocumented reuse acknowledgements.
  NSDictionary* attributes=@{(id)kCVPixelBufferIOSurfacePropertiesKey:@{}, (id)kCVPixelBufferMetalCompatibilityKey:@YES};
  OSCheck(CVPixelBufferCreate(kCFAllocatorDefault,1280,720,kCVPixelFormatType_32BGRA,(__bridge CFDictionaryRef)attributes,&w->output),"CVPixelBufferCreate");
  ++s->allocated;
  IOSurfaceRef dest=CVPixelBufferGetIOSurface(w->output); Require(dest,"Output is not IOSurface-backed");
  Require(dest!=surface,"Output must not alias Electron capture");
  MTLTextureDescriptor* desc=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:w->width height:w->height mipmapped:NO];
  desc.storageMode=MTLStorageModeShared; desc.usage=MTLTextureUsageShaderRead;
  w->source=[s->metal newTextureWithDescriptor:desc iosurface:surface plane:0];
  desc.width=1280; desc.height=720; desc.usage=MTLTextureUsageShaderRead | MTLTextureUsageRenderTarget;
  w->destination=[s->metal newTextureWithDescriptor:desc iosurface:dest plane:0];
  Require(w->source && w->destination,"Could not import Metal textures");
  w->command=[s->commands commandBuffer]; Require(w->command,"Could not create Metal command");
  if(w->width==1280 && w->height==720) {
    id<MTLBlitCommandEncoder> blit=[w->command blitCommandEncoder]; Require(blit,"Could not create Metal blit");
    [blit copyFromTexture:w->source sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(1280,720,1)
      toTexture:w->destination destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];
    [blit endEncoding];
  } else {
    // Clear the output to opaque black, then draw the complete portrait into a
    // centered 405x720 viewport. No stretch, crop, rotation, or CPU readback.
    if(!s->fitPipeline) s->fitPipeline=vc4m::CreateFitPipeline(s->metal);
    vc4m::EncodeFit(w->command,w->source,w->destination,s->fitPipeline);
  }
  napi_value promise; Check(napi_create_promise(env,&w->deferred,&promise));
  Check(napi_create_async_work(env,nullptr,String(env,"vc4m GPU copy"),Execute,Complete,w.get(),&w->async));
  [w->command commit]; w->submitMs=Ms(w->entered); Check(napi_queue_async_work(env,w->async));
  w.release(); return promise;
}
}
NAPI_MODULE_INIT() {
  try {
    auto s=std::make_unique<State>();
    napi_property_descriptor properties[]={
      {"discover",nullptr,Guard<Discovery>,nullptr,nullptr,nullptr,napi_default,s.get()},
      {"connect",nullptr,Guard<Connect>,nullptr,nullptr,nullptr,napi_default,s.get()},
      {"start",nullptr,Guard<Start>,nullptr,nullptr,nullptr,napi_default,s.get()},
      {"stop",nullptr,Guard<Stop>,nullptr,nullptr,nullptr,napi_default,s.get()},
      {"disconnect",nullptr,Guard<Disconnect>,nullptr,nullptr,nullptr,napi_default,s.get()},
      {"status",nullptr,Guard<Status>,nullptr,nullptr,nullptr,napi_default,s.get()},
      {"submit",nullptr,Guard<Submit>,nullptr,nullptr,nullptr,napi_default,s.get()}
    };
    Check(napi_define_properties(env,exports,sizeof(properties)/sizeof(properties[0]),properties));
    Check(napi_add_async_cleanup_hook(env,Cleanup,s.get(),&s->cleanup)); s.release(); return exports;
  } catch(const std::exception& e) { Throw(env,e.what()); return nullptr; }
}

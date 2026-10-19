// Offline GPU correctness test: no camera discovery, stream or system changes.
// CPU pixel writes/reads occur only here, never in the producer hot path.
#import <Foundation/Foundation.h>
#import <CoreVideo/CoreVideo.h>
#include "gpu-fit.h"
#include <cstdio>
#include <memory>
#include <string>

namespace {
void Require(bool ok,const char* message) { if(!ok) throw std::runtime_error(message); }
struct Pixels {
  CVPixelBufferRef buffer=nullptr;
  Pixels(size_t width,size_t height) {
    NSDictionary* attrs=@{(id)kCVPixelBufferIOSurfacePropertiesKey:@{}, (id)kCVPixelBufferMetalCompatibilityKey:@YES};
    Require(CVPixelBufferCreate(kCFAllocatorDefault,width,height,kCVPixelFormatType_32BGRA,
      (__bridge CFDictionaryRef)attrs,&buffer)==kCVReturnSuccess,"Allocate test pixel buffer");
  }
  ~Pixels() { if(buffer) CVPixelBufferRelease(buffer); }
};
void Color(const uint8_t* pixel,int r,int g,int b) {
  Require(pixel[0]==b && pixel[1]==g && pixel[2]==r && pixel[3]==255,"GPU fit changed color/orientation/alpha");
}
void Run(id<MTLDevice> device,id<MTLCommandQueue> queue,id<MTLRenderPipelineState> pipeline,size_t width,size_t height) {
  Pixels source(width,height),destination(1280,720);
  Require(CVPixelBufferLockBaseAddress(source.buffer,0)==kCVReturnSuccess,"Lock test source");
  auto* base=static_cast<uint8_t*>(CVPixelBufferGetBaseAddress(source.buffer));
  const size_t stride=CVPixelBufferGetBytesPerRow(source.buffer);
  for(size_t y=0;y<height;++y) for(size_t x=0;x<width;++x) {
    uint8_t* p=base+y*stride+x*4;
    const bool right=x>=width/2,bottom=y>=height/2;
    p[0]=bottom?255:0; p[1]=right?255:0; p[2]=(!right&&!bottom)||(right&&bottom)?255:0; p[3]=255;
  }
  CVPixelBufferUnlockBaseAddress(source.buffer,0);
  MTLTextureDescriptor* desc=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:width height:height mipmapped:NO];
  desc.storageMode=MTLStorageModeShared; desc.usage=MTLTextureUsageShaderRead;
  id<MTLTexture> input=[device newTextureWithDescriptor:desc iosurface:CVPixelBufferGetIOSurface(source.buffer) plane:0];
  desc.width=1280;desc.height=720;desc.usage=MTLTextureUsageRenderTarget;
  id<MTLTexture> output=[device newTextureWithDescriptor:desc iosurface:CVPixelBufferGetIOSurface(destination.buffer) plane:0];
  Require(input && output,"Import test textures");
  id<MTLCommandBuffer> command=[queue commandBuffer];
  vc4m::EncodeFit(command,input,output,pipeline);
  [command commit];[command waitUntilCompleted];
  Require(command.status==MTLCommandBufferStatusCompleted,"GPU fit command failed");
  Require(CVPixelBufferLockBaseAddress(destination.buffer,kCVPixelBufferLock_ReadOnly)==kCVReturnSuccess,"Lock test output");
  const auto* pixels=static_cast<const uint8_t*>(CVPixelBufferGetBaseAddress(destination.buffer));
  const size_t row=CVPixelBufferGetBytesPerRow(destination.buffer);
  auto at=[&](size_t x,size_t y){return pixels+y*row+x*4;};
  const bool portrait=width<height;
  Color(at(portrait?460:30,30),255,0,0);
  Color(at(portrait?820:1250,30),0,255,0);
  Color(at(portrait?460:30,690),0,0,255);
  Color(at(portrait?820:1250,690),255,255,255);
  int first=1280,last=-1;
  for(int x=0;x<1280;++x) {
    const auto* p=at(x,360);
    if(p[0] || p[1] || p[2]) { first=std::min(first,x);last=x; }
    Require(p[3]==255,"Output must be opaque including pillars");
    if(portrait && (x<437 || x>843)) Color(p,0,0,0);
  }
  if(portrait) Require(first>=437 && first<=438 && last>=841 && last<=843,"Portrait aspect-fit width/centering wrong");
  else Require(first==0 && last==1279,"Landscape must fill output");
  CVPixelBufferUnlockBaseAddress(destination.buffer,kCVPixelBufferLock_ReadOnly);
  printf("{\"source\":[%zu,%zu],\"output\":[1280,720],\"activeX\":[%d,%d],\"orientation\":\"preserved\",\"gpuMs\":%.6f}\n",
    width,height,first,last,(command.GPUEndTime-command.GPUStartTime)*1000);
}
}
int main() { @autoreleasepool { @try { try {
  id<MTLDevice> device=MTLCreateSystemDefaultDevice(); Require(device,"No Metal device");
  id<MTLCommandQueue> queue=[device newCommandQueue]; Require(queue,"No Metal queue");
  id<MTLRenderPipelineState> pipeline=vc4m::CreateFitPipeline(device);
  Run(device,queue,pipeline,720,1280); Run(device,queue,pipeline,1280,720);
  return 0;
} catch(const std::exception& e) { fprintf(stderr,"%s\n",e.what()); }
} @catch(NSException* e) { fprintf(stderr,"%s\n",e.reason.UTF8String); } return 1; } }

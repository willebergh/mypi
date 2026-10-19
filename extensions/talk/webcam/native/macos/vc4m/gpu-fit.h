#pragma once
#import <Metal/Metal.h>
#include <algorithm>
#include <stdexcept>

namespace vc4m {
// Shared by producer and an offline GPU correctness test. No CPU image access.
inline id<MTLRenderPipelineState> CreateFitPipeline(id<MTLDevice> device) {
  NSString* shader = [NSString stringWithUTF8String:R"METAL(
#include <metal_stdlib>
using namespace metal;
struct Raster { float4 position [[position]]; float2 uv; };
vertex Raster fitVertex(uint id [[vertex_id]]) {
  const float2 positions[3] = { float2(-1,-1), float2(3,-1), float2(-1,3) };
  const float2 p = positions[id];
  Raster out;
  out.position = float4(p,0,1);
  // Metal viewport origin is top-left; preserve Electron image orientation.
  out.uv = float2((p.x+1)*0.5, (1-p.y)*0.5);
  return out;
}
fragment float4 fitFragment(Raster in [[stage_in]], texture2d<float> source [[texture(0)]]) {
  constexpr sampler linearSampler(coord::normalized, address::clamp_to_edge, filter::linear);
  return source.sample(linearSampler, in.uv);
}
)METAL"];
  NSError* error = nil;
  id<MTLLibrary> library = [device newLibraryWithSource:shader options:nil error:&error];
  if (!library) throw std::runtime_error(error.localizedDescription.UTF8String ?: "Could not compile aspect-fit shader");
  MTLRenderPipelineDescriptor* descriptor = [MTLRenderPipelineDescriptor new];
  descriptor.vertexFunction = [library newFunctionWithName:@"fitVertex"];
  descriptor.fragmentFunction = [library newFunctionWithName:@"fitFragment"];
  descriptor.colorAttachments[0].pixelFormat = MTLPixelFormatBGRA8Unorm;
  id<MTLRenderPipelineState> pipeline = [device newRenderPipelineStateWithDescriptor:descriptor error:&error];
  if (!pipeline) throw std::runtime_error(error.localizedDescription.UTF8String ?: "Could not create aspect-fit pipeline");
  return pipeline;
}
inline void EncodeFit(id<MTLCommandBuffer> command, id<MTLTexture> source,
                      id<MTLTexture> destination, id<MTLRenderPipelineState> pipeline) {
  MTLRenderPassDescriptor* pass = [MTLRenderPassDescriptor renderPassDescriptor];
  pass.colorAttachments[0].texture = destination;
  pass.colorAttachments[0].loadAction = MTLLoadActionClear;
  pass.colorAttachments[0].storeAction = MTLStoreActionStore;
  pass.colorAttachments[0].clearColor = MTLClearColorMake(0,0,0,1);
  id<MTLRenderCommandEncoder> encoder = [command renderCommandEncoderWithDescriptor:pass];
  if (!encoder) throw std::runtime_error("Could not create aspect-fit render encoder");
  const double scale = std::min(double(destination.width)/source.width, double(destination.height)/source.height);
  const double width = source.width*scale, height = source.height*scale;
  [encoder setViewport:MTLViewport{(destination.width-width)/2, (destination.height-height)/2, width, height, 0, 1}];
  [encoder setRenderPipelineState:pipeline];
  [encoder setFragmentTexture:source atIndex:0];
  [encoder drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];
  [encoder endEncoding];
}
}

// SystemExtensions requests run IN Electron's main application process. A CLI
// helper would have the wrong containing bundle / signing identity for activation.
#include <node_api.h>
#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <Security/SecTask.h>
#import <SystemExtensions/SystemExtensions.h>

@interface PiCameraManager : NSObject <OSSystemExtensionRequestDelegate>
@property NSString* identifier;
@property NSString* installation;
@property NSString* activation;
@property NSString* requestState;
@property NSString* error;
@property NSString* reason;
@property NSString* team;
@property BOOL bundled;
@property BOOL canRequest;
@property BOOL closing;
@property OSSystemExtensionRequest* mutation;
@property OSSystemExtensionRequest* query;
- (void)preflight;
- (void)refresh;
- (void)submit:(BOOL)activate;
@end

static NSDictionary* SigningInfo(NSURL* url) {
  SecStaticCodeRef code = nullptr;
  if (SecStaticCodeCreateWithPath((__bridge CFURLRef)url, kSecCSDefaultFlags, &code) != errSecSuccess) return nil;
  CFDictionaryRef info = nullptr;
  OSStatus result = SecCodeCopySigningInformation(code, kSecCSSigningInformation, &info);
  CFRelease(code);
  if (result != errSecSuccess) return nil;
  return CFBridgingRelease(info);
}

@implementation PiCameraManager
- (instancetype)init {
  if ((self = [super init])) {
    _installation = @"unknown"; _activation = @"unknown";
    _requestState = @"idle"; _error = @""; _reason = @""; _team = @"";
  }
  return self;
}
- (void)preflight {
  self.canRequest = NO;
  NSURL* host = NSBundle.mainBundle.bundleURL;
  NSURL* extension = [host URLByAppendingPathComponent:[NSString stringWithFormat:@"Contents/Library/SystemExtensions/%@.systemextension", self.identifier]];
  self.bundled = [[NSFileManager defaultManager] fileExistsAtPath:[extension.path stringByAppendingPathComponent:@"Contents/Info.plist"]];
  if (!self.bundled) { self.reason = @"Camera extension is not bundled. Build the packaged app; pnpm dev cannot install it."; return; }
  NSDictionary* hostInfo = SigningInfo(host);
  NSDictionary* extensionInfo = SigningInfo(extension);
  self.team = hostInfo[(__bridge NSString*)kSecCodeInfoTeamIdentifier] ?: @"";
  NSString* extTeam = extensionInfo[(__bridge NSString*)kSecCodeInfoTeamIdentifier];
  if (!self.team.length || ![self.team isEqualToString:extTeam]) {
    self.reason = @"Signing required: host and camera extension must be signed by the same Apple Development/Developer ID team. Unsigned/ad-hoc builds cannot install a camera.";
    return;
  }
  SecTaskRef task = SecTaskCreateFromSelf(kCFAllocatorDefault);
  CFTypeRef entitlement = task ? SecTaskCopyValueForEntitlement(task, CFSTR("com.apple.developer.system-extension.install"), nullptr) : nullptr;
  BOOL allowed = entitlement && CFGetTypeID(entitlement) == CFBooleanGetTypeID() && CFBooleanGetValue((CFBooleanRef)entitlement);
  if (entitlement) CFRelease(entitlement);
  if (task) CFRelease(task);
  if (!allowed) { self.reason = @"The running app is missing its signed System Extension installation entitlement."; return; }
  if (![[host URLByResolvingSymlinksInPath].path hasPrefix:@"/Applications/"]) {
    self.reason = @"Move the signed Pi Talk Webcam.app into /Applications and launch that copy before installation.";
    return;
  }
  self.reason = @"";
  self.canRequest = YES;
}
- (void)refresh {
  [self preflight];
  if (!self.canRequest || self.query || self.closing) return;
  self.query = [OSSystemExtensionRequest propertiesRequestForExtension:self.identifier queue:dispatch_get_main_queue()];
  self.query.delegate = self;
  [[OSSystemExtensionManager sharedManager] submitRequest:self.query];
}
- (void)submit:(BOOL)activate {
  [self preflight];
  if (!self.canRequest || self.closing) return;
  if (self.mutation) { self.error = @"An activation/removal request is already pending; finish the system prompt first."; return; }
  self.error = @"";
  self.requestState = activate ? @"activating" : @"deactivating";
  self.mutation = activate ? [OSSystemExtensionRequest activationRequestForExtension:self.identifier queue:dispatch_get_main_queue()]
                          : [OSSystemExtensionRequest deactivationRequestForExtension:self.identifier queue:dispatch_get_main_queue()];
  self.mutation.delegate = self;
  [[OSSystemExtensionManager sharedManager] submitRequest:self.mutation];
}
- (OSSystemExtensionReplacementAction)request:(OSSystemExtensionRequest*)request actionForReplacingExtension:(OSSystemExtensionProperties*)existing withExtension:(OSSystemExtensionProperties*)replacement {
  // OS only offers this for matching team/identifier. Upgrade is explicitly user initiated.
  return self.closing ? OSSystemExtensionReplacementActionCancel : OSSystemExtensionReplacementActionReplace;
}
- (void)requestNeedsUserApproval:(OSSystemExtensionRequest*)request {
  if (self.closing) return;
  self.activation = @"awaiting-approval";
  self.requestState = @"awaiting-approval";
}
- (void)request:(OSSystemExtensionRequest*)request didFinishWithResult:(OSSystemExtensionRequestResult)result {
  if (self.closing) return;
  if (request != self.mutation) { if (request == self.query) self.query = nil; return; }
  if (result == OSSystemExtensionRequestWillCompleteAfterReboot) {
    self.requestState = @"reboot-required";
    self.activation = @"reboot-required";
  } else {
    self.requestState = @"completed";
  }
  self.mutation = nil;
  // Never infer enabled from submission/completion; ask the OS for actual properties.
  [self refresh];
}
- (void)request:(OSSystemExtensionRequest*)request didFailWithError:(NSError*)error {
  if (self.closing) return;
  self.error = [NSString stringWithFormat:@"%@ (%@ %ld)", error.localizedDescription, error.domain, (long)error.code];
  if (request == self.query) self.query = nil;
  else { self.requestState = @"failed"; self.mutation = nil; }
}
- (void)request:(OSSystemExtensionRequest*)request foundProperties:(NSArray<OSSystemExtensionProperties*>*)properties {
  if (self.closing) return;
  BOOL enabled = NO, approval = NO, removing = NO;
  for (OSSystemExtensionProperties* item in properties) {
    enabled |= item.isEnabled; approval |= item.isAwaitingUserApproval; removing |= item.isUninstalling;
  }
  self.installation = removing ? @"uninstalling" : properties.count ? @"installed" : @"not-installed";
  if (![self.requestState isEqualToString:@"reboot-required"]) {
    self.activation = enabled ? @"enabled" : approval ? @"awaiting-approval" : @"disabled";
  }
  self.query = nil;
}
@end

struct State { PiCameraManager* __strong manager = nil; };
static void Cleanup(void* data) {
  State* state = static_cast<State*>(data);
  state->manager.closing = YES;
  state->manager.mutation.delegate = nil;
  state->manager.query.delegate = nil;
  state->manager = nil;
  delete state;
}
static State* Get(napi_env env, napi_callback_info info, size_t* argc = nullptr, napi_value* argv = nullptr) {
  void* data = nullptr;
  napi_get_cb_info(env, info, argc, argv, nullptr, &data);
  return static_cast<State*>(data);
}
static void SetString(napi_env env, napi_value object, const char* key, NSString* value) {
  napi_value text;
  napi_create_string_utf8(env, value.UTF8String ?: "", NAPI_AUTO_LENGTH, &text);
  napi_set_named_property(env, object, key, text);
}
static void SetBool(napi_env env, napi_value object, const char* key, BOOL value) {
  napi_value result;
  napi_get_boolean(env, value, &result);
  napi_set_named_property(env, object, key, result);
}
static napi_value Status(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    PiCameraManager* m = Get(env, info)->manager;
    napi_value object;
    napi_create_object(env, &object);
    SetString(env, object, "installation", m.installation);
    SetString(env, object, "activation", m.activation);
    SetString(env, object, "requestState", m.requestState);
    SetString(env, object, "error", m.error);
    SetString(env, object, "instructions", m.reason);
    SetString(env, object, "teamID", m.team);
    SetBool(env, object, "bundled", m.bundled);
    SetBool(env, object, "canRequest", m.canRequest);
    return object;
  }
}
static napi_value Initialize(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    auto* state = Get(env, info);
    // Deliberately fixed; preload cannot choose arbitrary identifiers or load a helper.
    if (!state->manager) {
      state->manager = [PiCameraManager new];
      state->manager.identifier = @"com.pitalk.webcam.camera";
      [state->manager refresh];
    }
    return Status(env, info);
  }
}
static napi_value Activate(napi_env env, napi_callback_info info) {
  [Get(env, info)->manager submit:YES];
  return Status(env, info);
}
static napi_value Deactivate(napi_env env, napi_callback_info info) {
  [Get(env, info)->manager submit:NO];
  return Status(env, info);
}
static napi_value Refresh(napi_env env, napi_callback_info info) {
  [Get(env, info)->manager refresh];
  return Status(env, info);
}
NAPI_MODULE_INIT() {
  auto* state = new State;
  napi_property_descriptor properties[] = {
    {"initialize", nullptr, Initialize, nullptr, nullptr, nullptr, napi_default, state},
    {"status", nullptr, Status, nullptr, nullptr, nullptr, napi_default, state},
    {"activate", nullptr, Activate, nullptr, nullptr, nullptr, napi_default, state},
    {"deactivate", nullptr, Deactivate, nullptr, nullptr, nullptr, napi_default, state},
    {"refresh", nullptr, Refresh, nullptr, nullptr, nullptr, napi_default, state},
  };
  napi_define_properties(env, exports, sizeof(properties)/sizeof(properties[0]), properties);
  napi_add_env_cleanup_hook(env, Cleanup, state);
  return exports;
}

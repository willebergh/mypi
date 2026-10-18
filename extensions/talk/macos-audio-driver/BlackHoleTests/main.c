#include <assert.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define kDriver_Name "PiTalk"
#define kHas_Driver_Name_Format false
#define kBox_UID "io.github.willebergh.pitalk.audio.box"
#define kDevice_UID "io.github.willebergh.pitalk.audio.visible"
#define kDevice2_UID "io.github.willebergh.pitalk.audio.internal"
#define kDevice_Name "Pi Talk"
#define kDevice2_Name "Pi Talk Internal"
#define kDevice_IsHidden false
#define kDevice2_IsHidden true
#define kSampleRates 48000

#include "../BlackHole/BlackHole.c"

static UInt32 property_size(AudioObjectID objectID, AudioObjectPropertySelector selector,
                            AudioObjectPropertyScope scope)
{
    AudioObjectPropertyAddress address = { selector, scope, kAudioObjectPropertyElementMain };
    UInt32 size = 0;
    assert(BlackHole_GetPropertyDataSize(gAudioServerPlugInDriverRef, objectID, 0,
                                         &address, 0, NULL, &size) == noErr);
    return size;
}

static UInt32 uint_property(AudioObjectID objectID, AudioObjectPropertySelector selector)
{
    AudioObjectPropertyAddress address = { selector, kAudioObjectPropertyScopeGlobal,
                                           kAudioObjectPropertyElementMain };
    UInt32 value = UINT32_MAX;
    UInt32 size = sizeof(value);
    assert(BlackHole_GetPropertyData(gAudioServerPlugInDriverRef, objectID, 0, &address,
                                     0, NULL, size, &size, &value) == noErr);
    assert(size == sizeof(value));
    return value;
}

static AudioObjectID owner_of(AudioObjectID objectID)
{
    AudioObjectPropertyAddress address = { kAudioObjectPropertyOwner,
                                           kAudioObjectPropertyScopeGlobal,
                                           kAudioObjectPropertyElementMain };
    AudioObjectID owner = kAudioObjectUnknown;
    UInt32 size = sizeof(owner);
    assert(BlackHole_GetPropertyData(gAudioServerPlugInDriverRef, objectID, 0, &address,
                                     0, NULL, size, &size, &owner) == noErr);
    return owner;
}

static void assert_cross_routing(void)
{
    const UInt32 frames = 4;
    Float32 visibleSignal[8] = { 0.1f, 0.2f, 0.3f, 0.4f, 0.5f, 0.6f, 0.7f, 0.8f };
    Float32 internalSignal[8] = { -0.1f, -0.2f, -0.3f, -0.4f, -0.5f, -0.6f, -0.7f, -0.8f };
    Float32 capture[8] = { 0 };
    AudioServerPlugInIOCycleInfo cycle = { 0 };

    assert(BlackHole_StartIO(gAudioServerPlugInDriverRef, kObjectID_Device, 1) == noErr);
    assert(BlackHole_StartIO(gAudioServerPlugInDriverRef, kObjectID_Device2, 2) == noErr);

    cycle.mCurrentTime.mSampleTime = 100;
    cycle.mOutputTime.mSampleTime = 100;
    assert(BlackHole_DoIOOperation(gAudioServerPlugInDriverRef, kObjectID_Device,
                                   kObjectID_Stream_Output, 1,
                                   kAudioServerPlugInIOOperationWriteMix, frames,
                                   &cycle, visibleSignal, NULL) == noErr);
    cycle.mInputTime.mSampleTime = 100;
    assert(BlackHole_DoIOOperation(gAudioServerPlugInDriverRef, kObjectID_Device2,
                                   kObjectID_Stream_Input2, 2,
                                   kAudioServerPlugInIOOperationReadInput, frames,
                                   &cycle, capture, NULL) == noErr);
    assert(memcmp(capture, visibleSignal, sizeof(capture)) == 0);

    memset(capture, 1, sizeof(capture));
    assert(BlackHole_DoIOOperation(gAudioServerPlugInDriverRef, kObjectID_Device,
                                   kObjectID_Stream_Input, 1,
                                   kAudioServerPlugInIOOperationReadInput, frames,
                                   &cycle, capture, NULL) == noErr);
    Float32 silence[8] = { 0 };
    assert(memcmp(capture, silence, sizeof(capture)) == 0);

    cycle.mCurrentTime.mSampleTime = 200;
    cycle.mOutputTime.mSampleTime = 200;
    assert(BlackHole_DoIOOperation(gAudioServerPlugInDriverRef, kObjectID_Device2,
                                   kObjectID_Stream_Output2, 2,
                                   kAudioServerPlugInIOOperationWriteMix, frames,
                                   &cycle, internalSignal, NULL) == noErr);
    cycle.mInputTime.mSampleTime = 200;
    assert(BlackHole_DoIOOperation(gAudioServerPlugInDriverRef, kObjectID_Device,
                                   kObjectID_Stream_Input, 1,
                                   kAudioServerPlugInIOOperationReadInput, frames,
                                   &cycle, capture, NULL) == noErr);
    assert(memcmp(capture, internalSignal, sizeof(capture)) == 0);

    assert(BlackHole_StopIO(gAudioServerPlugInDriverRef, kObjectID_Device2, 2) == noErr);
    assert(BlackHole_StopIO(gAudioServerPlugInDriverRef, kObjectID_Device, 1) == noErr);
}

int main(void)
{
    assert(property_size(kObjectID_Device, kAudioObjectPropertyOwnedObjects,
                         kAudioObjectPropertyScopeGlobal) == 2 * sizeof(AudioObjectID));
    assert(property_size(kObjectID_Device2, kAudioObjectPropertyOwnedObjects,
                         kAudioObjectPropertyScopeGlobal) == 2 * sizeof(AudioObjectID));

    assert(property_size(kObjectID_Device, kAudioDevicePropertyStreams,
                         kAudioObjectPropertyScopeGlobal) == 2 * sizeof(AudioObjectID));
    assert(property_size(kObjectID_Device2, kAudioDevicePropertyStreams,
                         kAudioObjectPropertyScopeGlobal) == 2 * sizeof(AudioObjectID));
    assert(property_size(kObjectID_Device2, kAudioObjectPropertyControlList,
                         kAudioObjectPropertyScopeGlobal) == 0);

    assert(owner_of(kObjectID_Stream_Input) == kObjectID_Device);
    assert(owner_of(kObjectID_Stream_Output) == kObjectID_Device);
    assert(owner_of(kObjectID_Stream_Input2) == kObjectID_Device2);
    assert(owner_of(kObjectID_Stream_Output2) == kObjectID_Device2);

    assert(uint_property(kObjectID_Device, kAudioDevicePropertyIsHidden) == 0);
    assert(uint_property(kObjectID_Device2, kAudioDevicePropertyIsHidden) == 1);
    assert(uint_property(kObjectID_Device, kAudioDevicePropertyDeviceCanBeDefaultDevice) == 1);
    assert(uint_property(kObjectID_Device2, kAudioDevicePropertyDeviceCanBeDefaultDevice) == 0);

    AudioObjectPropertyAddress translate = { kAudioPlugInPropertyTranslateUIDToDevice,
                                             kAudioObjectPropertyScopeGlobal,
                                             kAudioObjectPropertyElementMain };
    CFStringRef uid = CFSTR(kDevice2_UID);
    AudioObjectID translated = kAudioObjectUnknown;
    UInt32 translatedSize = sizeof(translated);
    assert(BlackHole_GetPropertyData(gAudioServerPlugInDriverRef, kObjectID_PlugIn, 0,
                                     &translate, sizeof(uid), &uid, sizeof(translated),
                                     &translatedSize, &translated) == noErr);
    assert(translated == kObjectID_Device2);

    assert_cross_routing();
    puts("Pi Talk driver object-model and cross-routing tests passed");
    return 0;
}

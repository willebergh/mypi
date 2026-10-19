#include <node_api.h>
#include <AudioToolbox/AudioToolbox.h>
#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>
#include <Accelerate/Accelerate.h>
#include <mach/mach_time.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstddef>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace {
constexpr char kUid[] = "io.github.willebergh.pitalk.audio.visible";
constexpr double kRate = 48000.0;
constexpr size_t kBands = 12;
constexpr size_t kFFT = 2048;
constexpr size_t kHop = 1024;
constexpr size_t kLogFFT = 11;
constexpr double kStaleMs = 250.0;
constexpr float kSilence = 1.0e-7f;
constexpr float kPi = 3.14159265358979323846f;
static_assert(std::atomic<float>::is_always_lock_free);
static_assert(std::atomic<uint64_t>::is_always_lock_free);
static_assert(std::atomic<uint32_t>::is_always_lock_free);
static_assert(std::atomic<bool>::is_always_lock_free);

enum Fault : uint32_t { None, RenderFailed, Oversized, InvalidPCM };

AudioObjectPropertyAddress Address(AudioObjectPropertySelector selector,
                                   AudioObjectPropertyScope scope = kAudioObjectPropertyScopeGlobal) {
  return {selector, scope, kAudioObjectPropertyElementMain};
}

template <typename T>
OSStatus Property(AudioObjectID id, AudioObjectPropertySelector selector, T& value,
                  AudioObjectPropertyScope scope = kAudioObjectPropertyScopeGlobal) {
  auto address = Address(selector, scope);
  UInt32 size = sizeof(value);
  return AudioObjectGetPropertyData(id, &address, 0, nullptr, &size, &value);
}

std::string CFText(CFStringRef text) {
  char buffer[1024] = {};
  return text && CFStringGetCString(text, buffer, sizeof(buffer), kCFStringEncodingUTF8)
    ? std::string(buffer) : std::string();
}

bool IsExactDevice(AudioDeviceID id) {
  CFStringRef uid = nullptr;
  if (Property(id, kAudioDevicePropertyDeviceUID, uid) != noErr || !uid) return false;
  bool match = CFStringCompare(uid, CFSTR("io.github.willebergh.pitalk.audio.visible"), 0)
               == kCFCompareEqualTo;
  CFRelease(uid);
  return match;
}

struct Device {
  AudioDeviceID id = kAudioObjectUnknown;
  std::string name;
  std::string error;
};

// Metadata only: never creates an AudioUnit or queries/changes a default device.
Device FindDevice() {
  Device result;
  CFStringRef uid = CFSTR("io.github.willebergh.pitalk.audio.visible");
  AudioDeviceID id = kAudioObjectUnknown;
  AudioValueTranslation translation = {&uid, sizeof(uid), &id, sizeof(id)};
  auto address = Address(kAudioHardwarePropertyDeviceForUID);
  UInt32 size = sizeof(translation);
  OSStatus code = AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, nullptr,
                                            &size, &translation);
  if (code != noErr) {
    result.error = "Device UID lookup failed (OSStatus " + std::to_string(code) + ")";
    return result;
  }
  if (id == kAudioObjectUnknown || !IsExactDevice(id)) return result;
  UInt32 alive = 0;
  if (Property(id, kAudioDevicePropertyDeviceIsAlive, alive) != noErr || !alive) return result;
  result.id = id;
  CFStringRef name = nullptr;
  if (Property(id, kAudioObjectPropertyName, name) == noErr && name) {
    result.name = CFText(name);
    CFRelease(name);
  }
  return result;
}

void Check(OSStatus code, const char* operation) {
  if (code != noErr)
    throw std::runtime_error(std::string(operation) + " (OSStatus " + std::to_string(code) + ")");
}

float Bar(float amplitude) {
  if (!(amplitude > 0.001f)) return 0.0f; // -60 dBFS floor
  return std::clamp((20.0f * std::log10(amplitude) + 60.0f) / 60.0f, 0.0f, 1.0f);
}

float Smooth(float previous, float value, float seconds, float attack, float release) {
  float tau = value > previous ? attack : release;
  return value + (previous - value) * std::exp(-seconds / tau);
}

struct Meter {
  AudioUnit unit = nullptr; // lifecycle/metadata: JS thread only; RT reads while active
  AudioDeviceID device = kAudioObjectUnknown;
  bool initialized = false;
  bool started = false;
  std::string error;
  std::atomic<bool> accepting{false};
  std::atomic<uint32_t> inFlight{0};
  std::atomic<uint32_t> fault{None};
  std::atomic<int32_t> renderError{0};
  std::atomic<uint64_t> callbacks{0};
  std::atomic<uint64_t> framesSeen{0};
  std::atomic<uint64_t> lastTick{0};
  std::atomic<uint64_t> sequence{0};
  std::atomic<float> rms{0};
  std::atomic<float> peak{0};
  std::array<std::atomic<float>, kBands> bands{};
  double tickToMs = 0;
  UInt32 capacity = 0;
  std::array<std::unique_ptr<float[]>, 2> input;
  struct StereoBuffers { UInt32 count; AudioBuffer buffers[2]; } bufferList{};
  FFTSetup fft = nullptr;
  std::array<std::array<float, kFFT>, 2> history{};
  std::array<float, kFFT> window{}, real{}, imaginary{};
  std::array<float, kBands> bandPower{}, smoothedBands{};
  std::array<int, kFFT / 2 + 1> binBand{};
  size_t cursor = 0;
  size_t filled = 0;
  size_t hopFrames = 0;
  float windowEnergy = 0;
  float smoothRms = 0;
  float smoothPeak = 0;

  Meter() {
    mach_timebase_info_data_t base{};
    mach_timebase_info(&base);
    tickToMs = static_cast<double>(base.numer) / base.denom / 1.0e6;
    for (auto& band : bands) band.store(0, std::memory_order_relaxed);
  }
  ~Meter() { Stop(); }

  void ZeroPublished() {
    sequence.fetch_add(1, std::memory_order_acq_rel);
    rms.store(0, std::memory_order_relaxed);
    peak.store(0, std::memory_order_relaxed);
    for (auto& band : bands) band.store(0, std::memory_order_relaxed);
    sequence.fetch_add(1, std::memory_order_release);
  }

  void ResetDSP() {
    for (auto& channel : history) channel.fill(0);
    smoothedBands.fill(0);
    smoothRms = smoothPeak = 0;
    cursor = filled = hopFrames = 0;
  }

  // Called only on the JS thread. Stop/dispose quiesces CoreAudio before freeing RT state.
  void Stop() {
    accepting.store(false, std::memory_order_release);
    if (unit) {
      if (started) AudioOutputUnitStop(unit);
      while (inFlight.load(std::memory_order_acquire) != 0) std::this_thread::yield();
      // AUHAL may already have been stopped by device removal. Uninitialize/dispose
      // are still required. Never free callback storage before CoreAudio is detached.
      AURenderCallbackStruct empty{nullptr, nullptr};
      AudioUnitSetProperty(unit, kAudioOutputUnitProperty_SetInputCallback,
                           kAudioUnitScope_Global, 0, &empty, sizeof(empty));
      if (initialized) AudioUnitUninitialize(unit);
      AudioComponentInstanceDispose(unit);
      unit = nullptr;
    }
    while (inFlight.load(std::memory_order_acquire) != 0) std::this_thread::yield();
    started = initialized = false;
    device = kAudioObjectUnknown;
    input[0].reset();
    input[1].reset();
    capacity = 0;
    if (fft) vDSP_destroy_fftsetup(fft);
    fft = nullptr;
    ResetDSP();
    ZeroPublished();
    lastTick.store(0, std::memory_order_release);
    callbacks.store(0, std::memory_order_relaxed);
    framesSeen.store(0, std::memory_order_relaxed);
    fault.store(None, std::memory_order_release);
    renderError.store(0, std::memory_order_relaxed);
  }

  void FailRT(Fault reason, OSStatus code = noErr) {
    renderError.store(code, std::memory_order_relaxed);
    fault.store(reason, std::memory_order_release);
    ZeroPublished();
  }

  void Spectrum() {
    bandPower.fill(0);
    for (size_t channel = 0; channel < 2; ++channel) {
      for (size_t i = 0; i < kFFT; ++i) {
        real[i] = history[channel][(cursor + i) % kFFT] * window[i];
        imaginary[i] = 0;
      }
      DSPSplitComplex split{real.data(), imaginary.data()};
      vDSP_fft_zip(fft, &split, 1, kLogFFT, FFT_FORWARD);
      for (size_t bin = 1; bin < kFFT / 2; ++bin) {
        int band = binBand[bin];
        if (band >= 0)
          bandPower[band] += real[bin] * real[bin] + imaginary[bin] * imaginary[bin];
      }
    }
    // One-sided power, averaged over two channels: 2 / 2 cancels.
    const float scale = 1.0f / (static_cast<float>(kFFT) * windowEnergy);
    for (size_t i = 0; i < kBands; ++i) {
      float value = Bar(std::sqrt(std::max(0.0f, bandPower[i] * scale)));
      smoothedBands[i] = Smooth(smoothedBands[i], value, kHop / kRate, 0.035f, 0.180f);
    }
  }

  void Process(UInt32 count) {
    double sum = 0;
    float maximum = 0;
    for (UInt32 i = 0; i < count; ++i) {
      for (size_t channel = 0; channel < 2; ++channel) {
        const float sample = input[channel][i];
        if (!std::isfinite(sample)) { FailRT(InvalidPCM); return; }
        sum += static_cast<double>(sample) * sample;
        maximum = std::max(maximum, std::abs(sample));
        history[channel][cursor] = sample;
      }
      cursor = (cursor + 1) % kFFT;
      filled = std::min(filled + 1, kFFT);
      if (++hopFrames >= kHop) {
        hopFrames = 0;
        if (filled == kFFT) Spectrum();
      }
    }
    if (maximum <= kSilence) {
      // Do not leave an FFT window/smoothing tail visible during actual silence.
      ResetDSP();
      ZeroPublished();
      return;
    }
    float seconds = static_cast<float>(count / kRate);
    smoothRms = Smooth(smoothRms, Bar(static_cast<float>(std::sqrt(sum / (2.0 * count)))),
                       seconds, 0.010f, 0.150f);
    smoothPeak = Smooth(smoothPeak, Bar(maximum), seconds, 0.005f, 0.180f);
    sequence.fetch_add(1, std::memory_order_acq_rel);
    rms.store(smoothRms, std::memory_order_relaxed);
    peak.store(smoothPeak, std::memory_order_relaxed);
    for (size_t i = 0; i < kBands; ++i) bands[i].store(smoothedBands[i], std::memory_order_relaxed);
    sequence.fetch_add(1, std::memory_order_release);
  }

  static OSStatus Input(void* context, AudioUnitRenderActionFlags* flags,
                        const AudioTimeStamp* time, UInt32, UInt32 count, AudioBufferList*) {
    auto* self = static_cast<Meter*>(context);
    self->inFlight.fetch_add(1, std::memory_order_acq_rel);
    OSStatus code = noErr;
    if (self->accepting.load(std::memory_order_acquire) &&
        self->fault.load(std::memory_order_acquire) == None) {
      if (count > self->capacity) {
        self->FailRT(Oversized);
        code = kAudioUnitErr_TooManyFramesToProcess;
      } else if (count > 0) {
        // Restore pointers/lengths: AudioUnitRender may modify the AudioBufferList.
        for (size_t i = 0; i < 2; ++i) {
          self->bufferList.buffers[i] = {1, static_cast<UInt32>(count * sizeof(float)), self->input[i].get()};
        }
        self->bufferList.count = 2;
        code = AudioUnitRender(self->unit, flags, time, 1, count,
                              reinterpret_cast<AudioBufferList*>(&self->bufferList));
        if (code != noErr) self->FailRT(RenderFailed, code);
        else if (self->bufferList.count != 2 ||
                 self->bufferList.buffers[0].mData != self->input[0].get() ||
                 self->bufferList.buffers[1].mData != self->input[1].get() ||
                 self->bufferList.buffers[0].mDataByteSize < count * sizeof(float) ||
                 self->bufferList.buffers[1].mDataByteSize < count * sizeof(float)) {
          self->FailRT(InvalidPCM);
        } else {
          if (*flags & kAudioUnitRenderAction_OutputIsSilence) {
            self->ResetDSP();
            self->ZeroPublished();
          } else self->Process(count);
          if (self->fault.load(std::memory_order_acquire) == None) {
            self->framesSeen.fetch_add(count, std::memory_order_relaxed);
            self->callbacks.fetch_add(1, std::memory_order_relaxed);
            self->lastTick.store(mach_absolute_time(), std::memory_order_release);
          }
        }
      }
    }
    self->inFlight.fetch_sub(1, std::memory_order_release);
    return code;
  }

  void Refresh(const Device& current) {
    if (!unit) return;
    const auto reason = fault.load(std::memory_order_acquire);
    if (current.id != device || !IsExactDevice(device)) error = "PiTalk visible input disconnected";
    else if (reason != None) {
      if (reason == Oversized) error = "Audio callback exceeded preallocated maximum frames";
      else if (reason == InvalidPCM) error = "Invalid Float32 PCM returned by AUHAL";
      else error = "AudioUnitRender failed (OSStatus " +
                   std::to_string(renderError.load(std::memory_order_relaxed)) + ")";
    } else {
      Float64 rate = 0;
      AudioDeviceID selected = kAudioObjectUnknown;
      UInt32 size = sizeof(selected);
      if (Property(device, kAudioDevicePropertyNominalSampleRate, rate) != noErr ||
          !std::isfinite(rate) || std::abs(rate - kRate) > 0.5 ||
          AudioUnitGetProperty(unit, kAudioOutputUnitProperty_CurrentDevice,
                               kAudioUnitScope_Global, 0, &selected, &size) != noErr || selected != device)
        error = "PiTalk device format or AUHAL selection changed";
      else {
        const uint64_t tick = lastTick.load(std::memory_order_acquire);
        if (!tick || (mach_absolute_time() - tick) * tickToMs > kStaleMs)
          error = "PiTalk input callbacks stalled (>250 ms)";
      }
    }
    if (!error.empty()) Stop();
  }

  void Start() {
    if (unit) {
      Refresh(FindDevice());
      if (unit) return; // idempotent; no second stream
    }
    Stop();
    error.clear();
    try {
      const Device found = FindDevice();
      if (found.id == kAudioObjectUnknown)
        throw std::runtime_error(found.error.empty() ? "PiTalk visible input device is absent" : found.error);
      device = found.id;
      Float64 rate = 0;
      Check(Property(device, kAudioDevicePropertyNominalSampleRate, rate), "Read hardware sample rate");
      if (!std::isfinite(rate) || std::abs(rate - kRate) > 0.5)
        throw std::runtime_error("PiTalk input must already run at 48000 Hz; no device rate is changed");
      auto configAddress = Address(kAudioDevicePropertyStreamConfiguration, kAudioDevicePropertyScopeInput);
      UInt32 bytes = 0;
      Check(AudioObjectGetPropertyDataSize(device, &configAddress, 0, nullptr, &bytes), "Read input configuration size");
      if (bytes < sizeof(AudioBufferList)) throw std::runtime_error("PiTalk has no input stream");
      std::vector<unsigned char> storage(bytes);
      auto* config = reinterpret_cast<AudioBufferList*>(storage.data());
      Check(AudioObjectGetPropertyData(device, &configAddress, 0, nullptr, &bytes, config), "Read input configuration");
      const size_t header = offsetof(AudioBufferList, mBuffers);
      if (bytes < header || config->mNumberBuffers > (bytes - header) / sizeof(AudioBuffer))
        throw std::runtime_error("Invalid device input configuration");
      uint64_t channels = 0;
      for (UInt32 i = 0; i < config->mNumberBuffers; ++i) channels += config->mBuffers[i].mNumberChannels;
      if (channels < 2) throw std::runtime_error("PiTalk input must provide at least two input channels");

      AudioComponentDescription description{kAudioUnitType_Output, kAudioUnitSubType_HALOutput,
                                             kAudioUnitManufacturer_Apple, 0, 0};
      auto component = AudioComponentFindNext(nullptr, &description);
      if (!component) throw std::runtime_error("AUHAL component unavailable");
      Check(AudioComponentInstanceNew(component, &unit), "Create AUHAL");
      UInt32 yes = 1, no = 0;
      // No initialization or start until output is disabled and this exact UID is selected.
      Check(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input,
                                 1, &yes, sizeof(yes)), "Enable input bus 1");
      Check(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output,
                                 0, &no, sizeof(no)), "Disable output bus 0");
      Check(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global,
                                 0, &device, sizeof(device)), "Select exact PiTalk device");
      AudioDeviceID selected = kAudioObjectUnknown;
      UInt32 size = sizeof(selected);
      Check(AudioUnitGetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global,
                                 0, &selected, &size), "Verify AUHAL device");
      if (selected != device || !IsExactDevice(selected)) throw std::runtime_error("AUHAL UID verification failed");
      AudioStreamBasicDescription hardware{};
      size = sizeof(hardware);
      Check(AudioUnitGetProperty(unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input,
                                 1, &hardware, &size), "Probe AUHAL hardware format");
      if (hardware.mFormatID != kAudioFormatLinearPCM || !std::isfinite(hardware.mSampleRate) ||
          std::abs(hardware.mSampleRate - kRate) > 0.5 || hardware.mChannelsPerFrame < 2)
        throw std::runtime_error("AUHAL hardware must support stereo PCM at 48000 Hz");
      AudioStreamBasicDescription format{};
      format.mSampleRate = kRate;
      format.mFormatID = kAudioFormatLinearPCM;
      format.mFormatFlags = kAudioFormatFlagsNativeFloatPacked | kAudioFormatFlagIsNonInterleaved;
      format.mBytesPerPacket = format.mBytesPerFrame = sizeof(float);
      format.mFramesPerPacket = 1;
      format.mChannelsPerFrame = 2;
      format.mBitsPerChannel = 32;
      Check(AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output,
                                 1, &format, sizeof(format)), "Set Float32 stereo 48000 Hz client format");
      AudioStreamBasicDescription actual{};
      size = sizeof(actual);
      Check(AudioUnitGetProperty(unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output,
                                 1, &actual, &size), "Validate client format");
      if (actual.mFormatID != format.mFormatID || actual.mFormatFlags != format.mFormatFlags ||
          actual.mSampleRate != kRate || actual.mChannelsPerFrame != 2 || actual.mBitsPerChannel != 32 ||
          actual.mBytesPerFrame != sizeof(float) || actual.mBytesPerPacket != sizeof(float) ||
          actual.mFramesPerPacket != 1) throw std::runtime_error("AUHAL rejected exact client PCM format");
      // Explicit first-two-channel map; never map across another device.
      SInt32 channelMap[2] = {0, 1};
      Check(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_ChannelMap, kAudioUnitScope_Output,
                                 1, channelMap, sizeof(channelMap)), "Set stereo input channel map");
      UInt32 deviceFrames = 0;
      Check(Property(device, kAudioDevicePropertyBufferFrameSize, deviceFrames), "Read hardware buffer frames");
      UInt32 maximum = std::max<UInt32>(16384, deviceFrames);
      if (maximum > 65536) throw std::runtime_error("Hardware buffer size exceeds safe allocation limit");
      Check(AudioUnitSetProperty(unit, kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global,
                                 0, &maximum, sizeof(maximum)), "Set maximum callback frames");
      size = sizeof(capacity);
      Check(AudioUnitGetProperty(unit, kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global,
                                 0, &capacity, &size), "Read maximum callback frames");
      if (capacity < deviceFrames || capacity == 0 || capacity > 65536)
        throw std::runtime_error("Invalid AUHAL maximum frames");
      input[0] = std::make_unique<float[]>(capacity);
      input[1] = std::make_unique<float[]>(capacity);
      Check(AudioUnitSetProperty(unit, kAudioUnitProperty_ShouldAllocateBuffer, kAudioUnitScope_Output,
                                 1, &no, sizeof(no)), "Disable AUHAL client buffer allocation");
      fft = vDSP_create_fftsetup(kLogFFT, kFFTRadix2);
      if (!fft) throw std::runtime_error("Cannot allocate FFT setup");
      windowEnergy = 0;
      for (size_t i = 0; i < kFFT; ++i) {
        window[i] = 0.5f - 0.5f * std::cos(2.0f * kPi * i / (kFFT - 1));
        windowEnergy += window[i] * window[i];
      }
      binBand.fill(-1);
      for (size_t i = 1; i < kFFT / 2; ++i) {
        double hz = i * kRate / kFFT;
        if (hz >= 100.0 && hz <= 8000.0)
          binBand[i] = std::min<int>(kBands - 1, static_cast<int>(std::log(hz / 100.0) / std::log(80.0) * kBands));
      }
      AURenderCallbackStruct callback{Input, this};
      Check(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global,
                                 0, &callback, sizeof(callback)), "Install input callback");
      Check(AudioUnitInitialize(unit), "Initialize AUHAL");
      initialized = true;
      // Revalidate after setup: never start a stream whose UID/rate changed meanwhile.
      const Device recheck = FindDevice();
      Float64 finalRate = 0;
      if (recheck.id != device || Property(device, kAudioDevicePropertyNominalSampleRate, finalRate) != noErr ||
          !std::isfinite(finalRate) || std::abs(finalRate - kRate) > 0.5)
        throw std::runtime_error("PiTalk device changed during startup");
      accepting.store(true, std::memory_order_release);
      // Mark attempted start so even a failing AudioOutputUnitStart gets a Stop during unwind.
      started = true;
      Check(AudioOutputUnitStart(unit), "Start PiTalk input");
      const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(750);
      while (!callbacks.load(std::memory_order_acquire) && fault.load(std::memory_order_acquire) == None &&
             std::chrono::steady_clock::now() < deadline)
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
      if (fault.load(std::memory_order_acquire) != None) {
        Refresh(FindDevice());
        throw std::runtime_error(error.empty() ? "PiTalk input callback failed at startup" : error);
      }
      if (!callbacks.load(std::memory_order_acquire)) throw std::runtime_error("No PiTalk input callback within 750 ms");
      Refresh(FindDevice());
      if (!unit) throw std::runtime_error(error);
    } catch (const std::exception& exception) {
      error = exception.what();
      Stop();
      throw;
    }
  }
};

napi_value Boolean(napi_env env, bool value) {
  napi_value result; napi_get_boolean(env, value, &result); return result;
}
napi_value Number(napi_env env, double value) {
  napi_value result; napi_create_double(env, value, &result); return result;
}
napi_value Text(napi_env env, const std::string& value) {
  napi_value result; napi_create_string_utf8(env, value.c_str(), value.size(), &result); return result;
}
void Set(napi_env env, napi_value object, const char* key, napi_value value) {
  napi_set_named_property(env, object, key, value);
}
Meter* Self(napi_env env, napi_callback_info info) {
  void* data = nullptr; napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &data);
  return static_cast<Meter*>(data);
}
napi_value Status(napi_env env, Meter* self, const Device& device) {
  napi_value result; napi_create_object(env, &result);
  Set(env, result, "devicePresent", Boolean(env, device.id != kAudioObjectUnknown));
  Set(env, result, "running", Boolean(env, self->started));
  Set(env, result, "deviceUid", Text(env, kUid));
  if (!device.name.empty()) Set(env, result, "deviceName", Text(env, device.name));
  const std::string& error = self->error.empty() ? device.error : self->error;
  if (!error.empty()) Set(env, result, "error", Text(env, error));
  return result;
}
napi_value GetStatus(napi_env env, napi_callback_info info) {
  auto* self = Self(env, info);
  auto device = FindDevice();
  self->Refresh(device);
  return Status(env, self, device);
}
napi_value Start(napi_env env, napi_callback_info info) {
  auto* self = Self(env, info);
  try { self->Start(); }
  catch (const std::exception& error) {
    napi_throw_error(env, "PITALK_AUDIO_START", error.what()); return nullptr;
  }
  auto device = FindDevice();
  self->Refresh(device);
  if (!self->started) {
    napi_throw_error(env, "PITALK_AUDIO_START", self->error.c_str()); return nullptr;
  }
  return Status(env, self, device);
}
napi_value Stop(napi_env env, napi_callback_info info) {
  auto* self = Self(env, info);
  self->Stop();
  self->error.clear();
  napi_value result; napi_get_undefined(env, &result); return result;
}
napi_value ReadLevels(napi_env env, napi_callback_info info) {
  auto* self = Self(env, info);
  self->Refresh(FindDevice());
  float rms = 0, peak = 0;
  std::array<float, kBands> bands{};
  uint64_t tick = 0;
  bool valid = false;
  // Bounded snapshot retries. A busy writer can at worst yield one all-zero poll.
  if (self->started) for (int attempt = 0; attempt < 3; ++attempt) {
    auto before = self->sequence.load(std::memory_order_acquire);
    if (before & 1) continue;
    tick = self->lastTick.load(std::memory_order_acquire);
    rms = self->rms.load(std::memory_order_relaxed);
    peak = self->peak.load(std::memory_order_relaxed);
    for (size_t i = 0; i < kBands; ++i) bands[i] = self->bands[i].load(std::memory_order_relaxed);
    std::atomic_thread_fence(std::memory_order_acquire);
    auto after = self->sequence.load(std::memory_order_acquire);
    if (before == after && tick && (mach_absolute_time() - tick) * self->tickToMs <= kStaleMs) {
      valid = true; break;
    }
  }
  if (!valid) { rms = peak = 0; bands.fill(0); }
  napi_value result, array; napi_create_object(env, &result); napi_create_array_with_length(env, kBands, &array);
  Set(env, result, "rms", Number(env, rms));
  Set(env, result, "peak", Number(env, peak));
  for (size_t i = 0; i < kBands; ++i) napi_set_element(env, array, i, Number(env, bands[i]));
  Set(env, result, "bands", array);
  Set(env, result, "sampleRate", Number(env, kRate));
  if (valid) {
    double now = std::chrono::duration<double, std::milli>(std::chrono::system_clock::now().time_since_epoch()).count();
    Set(env, result, "updatedAt", Number(env, now - (mach_absolute_time() - tick) * self->tickToMs));
  }
  return result;
}
void Cleanup(void* context) { delete static_cast<Meter*>(context); }

napi_value Init(napi_env env, napi_value exports) {
  auto* self = new Meter(); // inert: no device lookup, AudioUnit, capture, or permission request
  if (napi_add_env_cleanup_hook(env, Cleanup, self) != napi_ok) {
    delete self;
    napi_throw_error(env, nullptr, "Cannot register audio environment cleanup");
    return nullptr;
  }
  napi_property_descriptor methods[] = {
    {"getStatus", nullptr, GetStatus, nullptr, nullptr, nullptr, napi_default, self},
    {"start", nullptr, Start, nullptr, nullptr, nullptr, napi_default, self},
    {"stop", nullptr, Stop, nullptr, nullptr, nullptr, napi_default, self},
    {"readLevels", nullptr, ReadLevels, nullptr, nullptr, nullptr, napi_default, self},
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  return exports;
}
} // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)

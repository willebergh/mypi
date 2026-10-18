//! UID-only access to Pi Talk's visible and hidden endpoints. No device list,
//! display-name match, persisted AudioDeviceID, or system-default fallback.

use anyhow::Result;
use cpal::traits::DeviceTrait;
use cpal::{Device, SampleFormat, SupportedStreamConfig, SupportedStreamConfigRange};
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::sync::mpsc;

use crate::audio;
use crate::protocol::{CoreAudioEndpoint, ErrorCode, Event, MAX_DEVICE_BYTES};

pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: u16 = 2;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ResolveFailure {
    Status(i32),
    Unknown,
    InvalidSize,
    #[cfg(not(target_os = "macos"))]
    UnsupportedPlatform,
}

type Resolution = std::result::Result<u32, ResolveFailure>;

// Kept independent of Core Audio so failure handling can be tested driver-free.
fn translated_id(status: i32, id: u32, size: u32) -> Resolution {
    if status != 0 {
        // noErr
        Err(ResolveFailure::Status(status))
    } else if id == 0 {
        // kAudioObjectUnknown
        Err(ResolveFailure::Unknown)
    } else if size != std::mem::size_of::<u32>() as u32 {
        Err(ResolveFailure::InvalidSize)
    } else {
        Ok(id)
    }
}

fn hidden_error(error: ResolveFailure) -> anyhow::Error {
    let code = match error {
        ResolveFailure::Unknown => ErrorCode::HiddenDeviceUnknown,
        _ => ErrorCode::HiddenUidUnresolved,
    };
    anyhow::Error::new(code).context(format!(
        "cannot resolve Pi Talk Internal ({error:?}); restart Core Audio or reinstall the Pi Talk driver"
    ))
}

fn check_pair(visible: Resolution, internal: Resolution) -> Result<()> {
    match (visible, internal) {
        (Err(ResolveFailure::Unknown), Err(ResolveFailure::Unknown)) => Err(anyhow::Error::new(
            ErrorCode::DriverNotInstalled,
        )
        .context("Pi Talk endpoints are absent; install the Pi Talk audio driver and retry")),
        (Err(error), _) => Err(
            anyhow::Error::new(ErrorCode::VisibleEndpointUnavailable).context(format!(
                "Pi Talk visible endpoint is unavailable ({error:?}); check the driver installation"
            )),
        ),
        (_, Err(error)) => Err(hidden_error(error)),
        (Ok(visible), Ok(internal)) if visible == internal => {
            Err(anyhow::Error::new(ErrorCode::HiddenUidUnresolved)
                .context("Pi Talk UIDs resolved to the same endpoint; reinstall the driver"))
        }
        (Ok(_), Ok(_)) => Ok(()),
    }
}

fn preflight_with(
    visible: &str,
    internal: &str,
    mut resolve: impl FnMut(&str) -> Resolution,
) -> Result<()> {
    // Deliberately resolve BOTH even when the first fails. IDs are not cached.
    let visible = resolve(visible);
    let internal = resolve(internal);
    check_pair(visible, internal)
}

pub fn preflight(visible: &str, internal: &str) -> Result<()> {
    preflight_with(visible, internal, resolve)
}

/// Called separately immediately before each input/output stream creation,
/// including output rebuilds after suppression. Never use a preflight ID.
pub fn hidden_device(uid: &str) -> Result<Device> {
    resolve_device_with(uid, resolve, device_from_id)
}

fn resolve_device_with<D>(
    uid: &str,
    resolve: impl FnOnce(&str) -> Resolution,
    create: impl FnOnce(u32) -> Result<D>,
) -> Result<D> {
    let id = resolve(uid).map_err(hidden_error)?;
    create(id)
}

#[cfg(target_os = "macos")]
fn device_from_id(id: u32) -> Result<Device> {
    // The local CPAL patch only re-exports this existing public constructor.
    Ok(cpal::CoreAudioDevice::new(id).into())
}

#[cfg(not(target_os = "macos"))]
fn device_from_id(_: u32) -> Result<Device> {
    Err(anyhow::Error::new(ErrorCode::DriverNotInstalled)
        .context("Pi Talk virtual audio requires macOS Core Audio"))
}

pub fn stream_config(device: &Device, input: bool) -> Result<SupportedStreamConfig> {
    let ranges: Vec<_> = if input {
        device
            .supported_input_configs()
            .map(|configs| configs.collect())
    } else {
        device
            .supported_output_configs()
            .map(|configs| configs.collect())
    }
    .map_err(|error| stream_error(error.into(), input))?;
    select_config(ranges)
}

fn select_config(
    ranges: impl IntoIterator<Item = SupportedStreamConfigRange>,
) -> Result<SupportedStreamConfig> {
    ranges
        .into_iter()
        .find_map(|range| {
            (range.channels() == CHANNELS && range.sample_format() == SampleFormat::F32)
                .then(|| range.try_with_sample_rate(SAMPLE_RATE))
                .flatten()
        })
        .ok_or_else(|| {
            anyhow::Error::new(ErrorCode::UnsupportedFormat).context(
                "Pi Talk Internal must support 48 kHz stereo float audio; check the driver version",
            )
        })
}

pub fn stream_error(error: anyhow::Error, input: bool) -> anyhow::Error {
    let code = match error.downcast_ref::<cpal::Error>().map(cpal::Error::kind) {
        Some(cpal::ErrorKind::UnsupportedConfig | cpal::ErrorKind::UnsupportedOperation) => {
            ErrorCode::UnsupportedFormat
        }
        Some(cpal::ErrorKind::DeviceNotAvailable | cpal::ErrorKind::StreamInvalidated) => {
            ErrorCode::DeviceLost
        }
        _ if input => ErrorCode::InputStreamCreationFailed,
        _ => ErrorCode::OutputStreamCreationFailed,
    };
    error.context(code).context(if input {
        "cannot start Pi Talk Internal capture; check microphone permission and the driver, then retry"
    } else {
        "cannot start Pi Talk Internal playback; check the driver and other audio clients, then retry"
    })
}

/// The input guard stays alive while output is created; on either failure all
/// created resources are dropped. Shared by the diagnostic and unit tests.
fn open_duplex<I, O>(
    input: impl FnOnce() -> Result<I>,
    output: impl FnOnce() -> Result<O>,
) -> Result<(I, O)> {
    let input = input()?;
    let output = output()?;
    Ok((input, output))
}

pub async fn diagnose(visible_uid: &str, internal_uid: &str) -> Event {
    let visible_id = resolve(visible_uid);
    let internal_id = resolve(internal_uid);
    let mut issues = Vec::new();
    let visible = describe(visible_uid, visible_id, &mut issues);
    let internal = describe(internal_uid, internal_id, &mut issues);
    let mut simultaneous_streams = false;
    let probe = check_pair(visible_id, internal_id).and_then(|()| {
        // Diagnostic callbacks have their own event sink: they must not emit
        // unrelated session activity/errors on the command protocol channel.
        let (events, _discard) = mpsc::channel(8);
        open_duplex(
            || audio::capture_virtual(internal_uid),
            || audio::playback_virtual(internal_uid, events),
        )
    });
    match probe {
        Ok((capture, playback)) => {
            // Both streams have been created AND started, simultaneously.
            // Capture is discarded; playback queues no samples (silence).
            tokio::time::sleep(Duration::from_millis(100)).await;
            if capture.failed.load(Ordering::Acquire) || playback.failed.load(Ordering::Acquire) {
                issues.push(ErrorCode::DeviceLost.to_string());
            } else {
                simultaneous_streams = true;
            }
            drop((capture, playback));
        }
        Err(error) => issues.push(
            error
                .downcast_ref::<ErrorCode>()
                .copied()
                .unwrap_or(ErrorCode::DeviceLost)
                .to_string(),
        ),
    }
    Event::VirtualAudioDiagnostics {
        visible,
        internal,
        simultaneous_streams,
        issues,
    }
}

fn describe(uid: &str, resolution: Resolution, issues: &mut Vec<String>) -> CoreAudioEndpoint {
    let mut endpoint = CoreAudioEndpoint::unresolved(uid);
    let Ok(id) = resolution else { return endpoint };
    endpoint.resolved = true;
    endpoint.audio_device_id = Some(id);
    if let Ok(device) = device_from_id(id) {
        endpoint.name = device.description().ok().map(|description| {
            let mut name = description.name().to_owned();
            while name.len() > MAX_DEVICE_BYTES {
                name.pop();
            }
            name
        });
        // CPAL 0.18.1 derives these channel counts from this ID's scoped
        // kAudioDevicePropertyStreamConfiguration, not the device list.
        endpoint.input_channels = device
            .supported_input_configs()
            .ok()
            .map(|configs| configs.map(|config| config.channels()).max().unwrap_or(0));
        endpoint.output_channels = device
            .supported_output_configs()
            .ok()
            .map(|configs| configs.map(|config| config.channels()).max().unwrap_or(0));
    }
    endpoint.nominal_sample_rate = nominal_sample_rate(id).ok();
    if endpoint.name.is_none()
        || endpoint.nominal_sample_rate.is_none()
        || endpoint.input_channels.is_none()
        || endpoint.output_channels.is_none()
    {
        issues.push(
            "device_lost: endpoint metadata is incomplete; retry after restarting Core Audio"
                .to_owned(),
        );
    }
    endpoint
}

#[cfg(not(target_os = "macos"))]
fn resolve(_: &str) -> Resolution {
    Err(ResolveFailure::UnsupportedPlatform)
}

#[cfg(not(target_os = "macos"))]
fn nominal_sample_rate(_: u32) -> Result<f64> {
    anyhow::bail!("Core Audio requires macOS")
}

#[cfg(target_os = "macos")]
use macos::{nominal_sample_rate, resolve};

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use objc2_core_audio::{
        AudioObjectGetPropertyData, AudioObjectPropertyAddress,
        kAudioDevicePropertyNominalSampleRate, kAudioHardwarePropertyTranslateUIDToDevice,
        kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject,
        kAudioObjectUnknown,
    };
    use objc2_core_foundation::CFString;
    use std::mem::size_of;
    use std::ptr::{NonNull, null};

    pub(super) fn resolve(uid: &str) -> Resolution {
        let uid = CFString::from_str(uid);
        let qualifier: *const CFString = &*uid;
        let address = AudioObjectPropertyAddress {
            mSelector: kAudioHardwarePropertyTranslateUIDToDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        };
        let mut id = kAudioObjectUnknown;
        let mut size = size_of::<u32>() as u32;
        // SAFETY: HAL requires a CFStringRef in the qualifier buffer (pointer
        // to the pointer, NOT the CFString object). Its retained owner and all
        // sized input/output storage remain live for this synchronous call.
        let status = unsafe {
            AudioObjectGetPropertyData(
                kAudioObjectSystemObject as u32,
                NonNull::from(&address),
                size_of::<*const CFString>() as u32,
                (&qualifier as *const *const CFString).cast(),
                NonNull::from(&mut size),
                NonNull::from(&mut id).cast(),
            )
        };
        translated_id(status, id, size)
    }

    pub(super) fn nominal_sample_rate(id: u32) -> Result<f64> {
        let address = AudioObjectPropertyAddress {
            mSelector: kAudioDevicePropertyNominalSampleRate,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        };
        let mut rate = 0_f64;
        let mut size = size_of::<f64>() as u32;
        // SAFETY: this property writes one Float64 to the sized buffer.
        let status = unsafe {
            AudioObjectGetPropertyData(
                id,
                NonNull::from(&address),
                0,
                null(),
                NonNull::from(&mut size),
                NonNull::from(&mut rate).cast(),
            )
        };
        anyhow::ensure!(
            status == 0 && size == size_of::<f64>() as u32 && rate.is_finite() && rate > 0.0,
            "nominal sample rate unavailable (OSStatus {status})"
        );
        Ok(rate)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cpal::SupportedBufferSize;
    use std::cell::Cell;
    use std::rc::Rc;

    #[test]
    fn translation_rejects_failure_even_with_nonzero_id_and_unknown_on_success() {
        assert_eq!(translated_id(-50, 42, 4), Err(ResolveFailure::Status(-50)));
        assert_eq!(translated_id(0, 0, 4), Err(ResolveFailure::Unknown));
        assert_eq!(translated_id(0, 42, 0), Err(ResolveFailure::InvalidSize));
        assert_eq!(translated_id(0, 42, 4), Ok(42));
    }

    #[test]
    fn preflight_resolves_both_and_distinguishes_missing_endpoints() {
        let mut calls = Vec::new();
        let error = preflight_with("visible", "internal", |uid| {
            calls.push(uid.to_owned());
            Err(ResolveFailure::Unknown)
        })
        .unwrap_err();
        assert_eq!(calls, ["visible", "internal"]);
        assert_eq!(
            error.downcast_ref::<ErrorCode>(),
            Some(&ErrorCode::DriverNotInstalled)
        );
        for (visible, internal, code) in [
            (
                Err(ResolveFailure::Unknown),
                Ok(2),
                ErrorCode::VisibleEndpointUnavailable,
            ),
            (
                Ok(1),
                Err(ResolveFailure::Unknown),
                ErrorCode::HiddenDeviceUnknown,
            ),
            (
                Ok(1),
                Err(ResolveFailure::Status(-50)),
                ErrorCode::HiddenUidUnresolved,
            ),
            (Ok(1), Ok(1), ErrorCode::HiddenUidUnresolved),
        ] {
            assert_eq!(
                check_pair(visible, internal)
                    .unwrap_err()
                    .downcast_ref::<ErrorCode>(),
                Some(&code)
            );
        }
        assert!(check_pair(Ok(1), Ok(2)).is_ok());
    }

    #[test]
    fn each_stream_open_uses_a_fresh_id_and_failed_translation_never_constructs() {
        let mut next_id = 40;
        // Input creation, output creation, then output recreation after resume.
        for expected in 40..43 {
            let id = resolve_device_with(
                "internal",
                |uid| {
                    assert_eq!(uid, "internal");
                    let id = next_id;
                    next_id += 1;
                    Ok(id)
                },
                Ok,
            )
            .unwrap();
            assert_eq!(id, expected);
        }
        assert!(
            resolve_device_with(
                "internal",
                |_| Err(ResolveFailure::Unknown),
                |_| -> Result<()> { panic!("must not construct or fall back") }
            )
            .is_err()
        );
    }

    #[test]
    fn stream_creation_errors_have_safe_actionable_codes() {
        for (kind, input, expected) in [
            (
                cpal::ErrorKind::DeviceBusy,
                true,
                ErrorCode::InputStreamCreationFailed,
            ),
            (
                cpal::ErrorKind::DeviceBusy,
                false,
                ErrorCode::OutputStreamCreationFailed,
            ),
            (
                cpal::ErrorKind::UnsupportedConfig,
                true,
                ErrorCode::UnsupportedFormat,
            ),
            (
                cpal::ErrorKind::DeviceNotAvailable,
                false,
                ErrorCode::DeviceLost,
            ),
        ] {
            let error = stream_error(cpal::Error::new(kind).into(), input);
            assert_eq!(error.downcast_ref::<ErrorCode>(), Some(&expected));
        }
    }

    #[test]
    fn virtual_format_never_accepts_mono_or_a_different_rate() {
        let range = |channels, min, max, format| {
            SupportedStreamConfigRange::new(
                channels,
                min,
                max,
                SupportedBufferSize::Unknown,
                format,
            )
        };
        for unsupported in [
            range(1, 48_000, 48_000, SampleFormat::F32),
            range(2, 44_100, 44_100, SampleFormat::F32),
            range(2, 48_000, 48_000, SampleFormat::I16),
        ] {
            assert_eq!(
                select_config([unsupported])
                    .unwrap_err()
                    .downcast_ref::<ErrorCode>(),
                Some(&ErrorCode::UnsupportedFormat)
            );
        }
        let config = select_config([range(2, 44_100, 96_000, SampleFormat::F32)]).unwrap();
        assert_eq!((config.channels(), config.sample_rate()), (2, 48_000));
    }

    #[test]
    fn duplex_probe_holds_capture_and_releases_both_including_partial_failure() {
        struct Guard(Rc<Cell<usize>>);
        impl Drop for Guard {
            fn drop(&mut self) {
                self.0.set(self.0.get() - 1);
            }
        }
        let live = Rc::new(Cell::new(0));
        let input = || {
            live.set(1);
            Ok(Guard(live.clone()))
        };
        let output = || {
            assert_eq!(live.get(), 1);
            live.set(2);
            Ok(Guard(live.clone()))
        };
        let streams = open_duplex(input, output).unwrap();
        assert_eq!(live.get(), 2);
        drop(streams);
        assert_eq!(live.get(), 0);
        assert!(
            open_duplex(input, || -> Result<Guard> {
                anyhow::bail!("output failed")
            })
            .is_err()
        );
        assert_eq!(live.get(), 0);
    }
}

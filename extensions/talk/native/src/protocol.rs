use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u8 = 7;
pub const MAX_SDP_BYTES: usize = 256 * 1024;
pub const MAX_DATA_MESSAGE_BYTES: usize = 64 * 1024;
pub const MAX_PCM_BYTES: usize = 64 * 1024;
pub const MAX_DEVICE_BYTES: usize = 512;
pub const MAX_DEVICES: usize = 128;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub const VIRTUAL_VISIBLE_UID: &str = "io.github.willebergh.pitalk.audio.visible";
pub const VIRTUAL_INTERNAL_UID: &str = "io.github.willebergh.pitalk.audio.internal";

pub fn parse_command(input: &str) -> anyhow::Result<Command> {
    let value: Value = serde_json::from_str(input)?;
    let object = value
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("voice helper command must be an object"))?;
    let command_type = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("voice helper command requires a string type"))?;
    let allowed: &[&str] = match command_type {
        "list_devices" | "stop" | "shutdown" => &["type"],
        "start_v3" => &["type", "microphone", "speaker"],
        "start_v3_bridge" => &["type"],
        "start_v3_virtual" | "diagnose_virtual_audio" => &["type", "visible_uid", "internal_uid"],
        "set_input_muted" => &["type", "muted"],
        "set_speaker_suppressed" => &["type", "suppressed", "epoch"],
        "apply_answer" => &["type", "sdp"],
        "start_dictation" => &["type", "microphone"],
        "send_data" => &["type", "message"],
        "send_pcm" => &["type", "audio", "sample_rate", "num_channels"],
        _ => anyhow::bail!("unknown voice helper command type {command_type}"),
    };
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        anyhow::bail!("unknown {command_type} field {key}");
    }
    Ok(serde_json::from_value(value)?)
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    ListDevices,
    StartV3 {
        microphone: Option<String>,
        speaker: Option<String>,
    },
    StartV3Bridge,
    StartV3Virtual {
        visible_uid: String,
        internal_uid: String,
    },
    DiagnoseVirtualAudio {
        visible_uid: String,
        internal_uid: String,
    },
    SetInputMuted {
        muted: bool,
    },
    SetSpeakerSuppressed {
        suppressed: bool,
        epoch: u64,
    },
    ApplyAnswer {
        sdp: String,
    },
    StartDictation {
        microphone: Option<String>,
    },
    SendData {
        message: Value,
    },
    SendPcm {
        audio: String,
        sample_rate: u32,
        num_channels: u16,
    },
    Stop,
    Shutdown,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    Ready {
        version: u8,
        /// Wall-clock milliseconds since the Unix epoch when the helper became ready.
        ready_at_ms: u64,
    },
    Devices {
        inputs: Vec<AudioDevice>,
        outputs: Vec<AudioDevice>,
    },
    Offer {
        sdp: String,
    },
    State {
        state: &'static str,
    },
    Data {
        message: Value,
    },
    Pcm {
        audio: String,
        sample_rate: u32,
        num_channels: u16,
        #[serde(skip_serializing_if = "Option::is_none")]
        epoch: Option<u64>,
    },
    PlaybackActivity,
    /// Diagnostic speaker timing. Microseconds are relative to the start of
    /// the epoch's playout; absent stages had not happened yet.
    PlayoutStats {
        epoch: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        first_rtp_us: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        first_decode_us: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        first_enqueue_us: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        first_output_us: Option<u64>,
        underruns: u64,
        start_threshold_ms: u64,
    },
    VirtualAudioDiagnostics {
        visible: CoreAudioEndpoint,
        internal: CoreAudioEndpoint,
        simultaneous_streams: bool,
        issues: Vec<String>,
    },
    Error {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<ErrorCode>,
    },
    Stopped,
}

/// Closed vocabulary: never expose arbitrary backend text as an IPC error code.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    DriverNotInstalled,
    VisibleEndpointUnavailable,
    HiddenUidUnresolved,
    HiddenDeviceUnknown,
    InputStreamCreationFailed,
    OutputStreamCreationFailed,
    UnsupportedFormat,
    DeviceLost,
}

impl std::fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let value = serde_json::to_value(self).map_err(|_| std::fmt::Error)?;
        f.write_str(value.as_str().ok_or(std::fmt::Error)?)
    }
}

impl std::error::Error for ErrorCode {}

impl Event {
    pub fn error(error: &anyhow::Error) -> Self {
        Self::Error {
            message: format!("{error:#}"),
            code: error.downcast_ref::<ErrorCode>().copied(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct CoreAudioEndpoint {
    pub uid: String,
    pub resolved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_device_id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nominal_sample_rate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_channels: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_channels: Option<u16>,
}

impl CoreAudioEndpoint {
    pub fn unresolved(uid: &str) -> Self {
        Self {
            uid: uid.to_owned(),
            resolved: false,
            audio_device_id: None,
            name: None,
            nominal_sample_rate: None,
            input_channels: None,
            output_channels: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

impl Command {
    pub fn validate(&self) -> anyhow::Result<()> {
        match self {
            Self::StartV3Virtual {
                visible_uid,
                internal_uid,
            }
            | Self::DiagnoseVirtualAudio {
                visible_uid,
                internal_uid,
            } => {
                for uid in [visible_uid, internal_uid] {
                    if uid.is_empty()
                        || uid.len() > MAX_DEVICE_BYTES
                        || uid.chars().any(char::is_control)
                    {
                        anyhow::bail!(
                            "virtual audio UID must be nonempty, control-free, and at most {MAX_DEVICE_BYTES} bytes"
                        );
                    }
                }
                if visible_uid != VIRTUAL_VISIBLE_UID || internal_uid != VIRTUAL_INTERNAL_UID {
                    anyhow::bail!(
                        "virtual audio requires the fixed Pi Talk visible and internal UIDs"
                    );
                }
            }
            Self::StartV3 {
                microphone,
                speaker,
            } if microphone
                .as_ref()
                .is_some_and(|value| value.len() > MAX_DEVICE_BYTES)
                || speaker
                    .as_ref()
                    .is_some_and(|value| value.len() > MAX_DEVICE_BYTES) =>
            {
                anyhow::bail!("audio device id exceeds {MAX_DEVICE_BYTES} bytes")
            }
            Self::StartDictation { microphone }
                if microphone
                    .as_ref()
                    .is_some_and(|value| value.len() > MAX_DEVICE_BYTES) =>
            {
                anyhow::bail!("audio device id exceeds {MAX_DEVICE_BYTES} bytes")
            }
            Self::ApplyAnswer { sdp } if sdp.len() > MAX_SDP_BYTES => {
                anyhow::bail!("answer SDP exceeds {MAX_SDP_BYTES} bytes")
            }
            Self::SetSpeakerSuppressed { epoch, .. } if *epoch > MAX_SAFE_INTEGER => {
                anyhow::bail!("speaker epoch exceeds the JavaScript safe integer range")
            }
            Self::SendData { message } => {
                let size = serde_json::to_vec(message)?.len();
                if size > MAX_DATA_MESSAGE_BYTES {
                    anyhow::bail!("data-channel message exceeds {MAX_DATA_MESSAGE_BYTES} bytes");
                }
            }
            Self::SendPcm {
                audio,
                sample_rate,
                num_channels,
            } => {
                if *sample_rate != 24_000 || *num_channels != 1 {
                    anyhow::bail!("bridge PCM must be 24 kHz mono");
                }
                if audio.len() > MAX_PCM_BYTES * 4 / 3 + 4 {
                    anyhow::bail!("bridge PCM exceeds {MAX_PCM_BYTES} bytes");
                }
            }
            _ => {}
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn virtual_commands_require_the_fixed_bounded_uids_and_no_fallback_fields() {
        assert_eq!(PROTOCOL_VERSION, 7);
        for kind in ["start_v3_virtual", "diagnose_virtual_audio"] {
            let command = |visible: &str, internal: &str| {
                serde_json::json!({
                    "type": kind, "visible_uid": visible, "internal_uid": internal,
                })
            };
            let valid = command(VIRTUAL_VISIBLE_UID, VIRTUAL_INTERNAL_UID);
            assert!(
                parse_command(&valid.to_string())
                    .unwrap()
                    .validate()
                    .is_ok()
            );
            for invalid in [
                command("", VIRTUAL_INTERNAL_UID),
                command(VIRTUAL_VISIBLE_UID, ""),
                command("same", "same"),
                command("visible", "internal"),
                command(VIRTUAL_VISIBLE_UID, "bad\nuid"),
                command(VIRTUAL_VISIBLE_UID, &"x".repeat(MAX_DEVICE_BYTES + 1)),
            ] {
                assert!(
                    parse_command(&invalid.to_string())
                        .unwrap()
                        .validate()
                        .is_err()
                );
            }
            for field in ["microphone", "speaker", "device_id"] {
                let mut invalid = valid.clone();
                invalid[field] = Value::String("default".to_owned());
                assert!(parse_command(&invalid.to_string()).is_err());
            }
            let mut missing = valid.clone();
            missing.as_object_mut().unwrap().remove("internal_uid");
            assert!(parse_command(&missing.to_string()).is_err());
        }
    }

    #[test]
    fn diagnostic_shape_and_optional_safe_codes_match_protocol_seven() {
        let event = Event::VirtualAudioDiagnostics {
            visible: CoreAudioEndpoint {
                uid: "visible".to_owned(),
                resolved: true,
                audio_device_id: Some(23),
                name: Some("Pi Talk".to_owned()),
                nominal_sample_rate: Some(48_000.0),
                input_channels: Some(2),
                output_channels: Some(2),
            },
            internal: CoreAudioEndpoint::unresolved("internal"),
            simultaneous_streams: false,
            issues: vec!["hidden_device_unknown".to_owned()],
        };
        let json = serde_json::to_value(event).unwrap();
        assert_eq!(json["type"], "virtual_audio_diagnostics");
        assert_eq!(
            json["internal"],
            serde_json::json!({"uid":"internal", "resolved":false})
        );
        assert_eq!(json["visible"].as_object().unwrap().len(), 7);
        assert_eq!(json.as_object().unwrap().len(), 5);
        let generic =
            serde_json::to_value(Event::error(&anyhow::anyhow!("other failure"))).unwrap();
        assert!(generic.get("code").is_none());
        for code in [
            ErrorCode::DriverNotInstalled,
            ErrorCode::VisibleEndpointUnavailable,
            ErrorCode::HiddenUidUnresolved,
            ErrorCode::HiddenDeviceUnknown,
            ErrorCode::InputStreamCreationFailed,
            ErrorCode::OutputStreamCreationFailed,
            ErrorCode::UnsupportedFormat,
            ErrorCode::DeviceLost,
        ] {
            let error = anyhow::Error::new(code).context("actionable context");
            let event = serde_json::to_value(Event::error(&error)).unwrap();
            assert_eq!(event["code"], code.to_string());
            assert!(
                code.to_string()
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b == b'_')
            );
        }
    }

    #[test]
    fn commands_are_closed_and_bounded() {
        assert!(parse_command(r#"{"type":"unknown"}"#).is_err());
        assert!(parse_command(r#"{"type":"stop","extra":true}"#).is_err());
        assert!(parse_command(r#"{"type":"set_input_muted","muted":true}"#).is_ok());
        assert!(parse_command(r#"{"type":"set_input_muted","muted":"yes"}"#).is_err());
        assert!(
            parse_command(r#"{"type":"set_speaker_suppressed","suppressed":true,"epoch":1}"#)
                .is_ok()
        );
        assert!(
            parse_command(r#"{"type":"set_speaker_suppressed","suppressed":true,"epoch":-1}"#)
                .is_err()
        );
        assert!(parse_command(r#"{"type":"start_v3_bridge"}"#).is_ok());
        assert!(
            Command::SendPcm {
                audio: "AA==".to_owned(),
                sample_rate: 48_000,
                num_channels: 1,
            }
            .validate()
            .is_err()
        );
        assert!(
            Command::SetSpeakerSuppressed {
                suppressed: true,
                epoch: MAX_SAFE_INTEGER + 1,
            }
            .validate()
            .is_err()
        );
        assert!(
            Command::StartDictation {
                microphone: Some("x".repeat(MAX_DEVICE_BYTES + 1)),
            }
            .validate()
            .is_err()
        );
        assert!(
            Command::ApplyAnswer {
                sdp: "x".repeat(MAX_SDP_BYTES + 1)
            }
            .validate()
            .is_err()
        );
    }
}

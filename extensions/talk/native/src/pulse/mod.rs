//! PulseAudio devices for the macOS helper. A PulseAudio or PipeWire server
//! reachable through a Unix socket, such as one that `ssh -R` forwards from
//! another machine, carries call audio there instead of Core Audio.
//!
//! Adapted from cpal 0.18.1 `src/host/pulseaudio/mod.rs` (Apache-2.0), which
//! cpal builds only on Linux and the BSDs. See `VENDORED.md`. Changes: the host
//! is exposed through cpal's `custom` feature; one client connection is cached
//! for the helper's lifetime and replaced when it stops answering; every
//! server request has a deadline, and a missed deadline shuts the socket down
//! so that pending requests fail instead of waiting forever; an absent
//! cookie is sent as 256 zero bytes, which PipeWire accepts and an empty
//! cookie is not; device ids and names identify PulseAudio; only the stream
//! formats and channel maps this helper uses remain.

mod stream;

use std::ffi::{CStr, CString};
use std::fmt;
use std::hash::{Hash, Hasher};
use std::mem::discriminant;
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex, PoisonError, mpsc};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait};
use cpal::{
    BufferSize, Data, DeviceDescription, DeviceDescriptionBuilder, DeviceDirection, DeviceId,
    Error, ErrorKind, InputCallbackInfo, OutputCallbackInfo, SampleFormat, StreamConfig,
    SupportedBufferSize, SupportedStreamConfig, SupportedStreamConfigRange,
};
use futures::executor::block_on;
use pulseaudio::protocol;

use stream::Stream;

/// The deadline for every server request, including the handshake.
const SERVER_TIMEOUT: Duration = Duration::from_secs(2);
const COOKIE_BYTES: usize = 256;
// The server converts each stream to the requested format, so the device's
// own format never reaches the helper.
const FORMATS: &[SampleFormat] = &[SampleFormat::F32, SampleFormat::I16];

static CONNECTION: Mutex<Option<Connection>> = Mutex::new(None);

/// One server connection: the protocol client, and a handle to its socket.
/// Shutting the socket down ends the client's reactor thread, which fails
/// every pending request and every stream on the connection.
#[derive(Clone, Debug)]
struct Connection {
    client: pulseaudio::Client,
    socket: Arc<UnixStream>,
}

impl Connection {
    /// Runs `call` with a deadline. A server that misses it is treated as
    /// gone: the connection is aborted, so the call fails as well.
    fn call<R: Send + 'static>(
        &self,
        call: impl FnOnce(pulseaudio::Client) -> R + Send + 'static,
    ) -> Option<R> {
        let result = bounded(self.client.clone(), call);
        if result.is_none() {
            self.abort();
        }
        result
    }

    fn abort(&self) {
        let _ = self.socket.shutdown(Shutdown::Both);
    }
}

fn timed_out() -> Error {
    Error::with_message(
        ErrorKind::DeviceNotAvailable,
        "PulseAudio server stopped answering",
    )
}

/// Returns a cpal host for the PulseAudio server named by `PULSE_SERVER`
/// (`unix:` paths only) or the standard runtime paths, or `None` when no
/// server answers.
pub fn host() -> Option<cpal::Host> {
    pulseaudio::socket_path_from_env()?;
    let connection = connection()?;
    Some(cpal::Host::from(cpal::platform::CustomHost::from_host(
        Host { connection },
    )))
}

fn connection() -> Option<Connection> {
    let mut cached = CONNECTION.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(connection) = cached.as_ref() {
        if connection.call(|client| block_on(client.server_info()).is_ok()) == Some(true) {
            return Some(connection.clone());
        }
        connection.abort();
    }
    *cached = connect();
    cached.clone()
}

/// Runs a blocking call on its own thread and waits at most SERVER_TIMEOUT.
/// A thread that outlives the wait ends once its connection is aborted.
fn bounded<T: Send + 'static, R: Send + 'static>(
    value: T,
    call: impl FnOnce(T) -> R + Send + 'static,
) -> Option<R> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(call(value));
    });
    rx.recv_timeout(SERVER_TIMEOUT).ok()
}

fn connect() -> Option<Connection> {
    let socket = UnixStream::connect(pulseaudio::socket_path_from_env()?).ok()?;
    let handle = Arc::new(socket.try_clone().ok()?);
    let cookie = pulseaudio::cookie_path_from_env()
        .and_then(|path| std::fs::read(path).ok())
        .filter(|cookie| cookie.len() == COOKIE_BYTES)
        .unwrap_or_else(|| vec![0; COOKIE_BYTES]);
    let name = CString::new(format!("pi-codex-voice-{}", std::process::id()))
        .expect("client name has no NUL");
    match bounded(socket, move |socket| {
        pulseaudio::Client::new_unix(name, socket, Some(cookie))
    }) {
        Some(Ok(client)) => Some(Connection {
            client,
            socket: handle,
        }),
        Some(Err(_)) => None,
        None => {
            let _ = handle.shutdown(Shutdown::Both);
            None
        }
    }
}

fn error(err: pulseaudio::ClientError) -> Error {
    use pulseaudio::ClientError::*;
    let kind = match &err {
        ServerUnavailable => ErrorKind::HostUnavailable,
        UnexpectedSequenceNumber | Disconnected | Io(_) => ErrorKind::StreamInvalidated,
        ServerError(protocol::PulseError::NoEntity) => ErrorKind::DeviceNotAvailable,
        ServerError(protocol::PulseError::NoData) => ErrorKind::Xrun,
        _ => ErrorKind::BackendError,
    };
    Error::with_message(kind, format!("PulseAudio: {err}"))
}

fn pulse_format(format: SampleFormat) -> Option<protocol::SampleFormat> {
    match format {
        SampleFormat::I16 => Some(protocol::SampleFormat::S16Le),
        SampleFormat::F32 => Some(protocol::SampleFormat::Float32Le),
        _ => None,
    }
}

struct Host {
    connection: Connection,
}

impl HostTrait for Host {
    type Devices = std::vec::IntoIter<Device>;
    type Device = Device;

    fn is_available() -> bool {
        pulseaudio::socket_path_from_env().is_some()
    }

    fn devices(&self) -> Result<Self::Devices, Error> {
        let (sinks, sources) = self
            .connection
            .call(|client| {
                block_on(async {
                    Ok::<_, pulseaudio::ClientError>((
                        client.list_sinks().await?,
                        client.list_sources().await?,
                    ))
                })
            })
            .ok_or_else(timed_out)?
            .map_err(error)?;
        let connection = &self.connection;
        Ok(sinks
            .into_iter()
            .map(|info| Device::Sink {
                connection: connection.clone(),
                info,
            })
            .chain(sources.into_iter().map(|info| Device::Source {
                connection: connection.clone(),
                info,
            }))
            .collect::<Vec<_>>()
            .into_iter())
    }

    fn default_input_device(&self) -> Option<Self::Device> {
        let info = self
            .connection
            .call(|client| {
                block_on(client.source_info_by_name(protocol::DEFAULT_SOURCE.to_owned()))
            })?
            .ok()?;
        Some(Device::Source {
            connection: self.connection.clone(),
            info,
        })
    }

    fn default_output_device(&self) -> Option<Self::Device> {
        let info = self
            .connection
            .call(|client| block_on(client.sink_info_by_name(protocol::DEFAULT_SINK.to_owned())))?
            .ok()?;
        Some(Device::Sink {
            connection: self.connection.clone(),
            info,
        })
    }
}

/// A PulseAudio sink or source, identified by its server name.
#[derive(Clone, Debug)]
enum Device {
    Sink {
        connection: Connection,
        info: protocol::SinkInfo,
    },
    Source {
        connection: Connection,
        info: protocol::SourceInfo,
    },
}

impl Device {
    fn name(&self) -> &CStr {
        match self {
            Device::Sink { info, .. } => &info.name,
            Device::Source { info, .. } => &info.name,
        }
    }
}

impl PartialEq for Device {
    fn eq(&self, other: &Self) -> bool {
        discriminant(self) == discriminant(other) && self.name() == other.name()
    }
}

impl Eq for Device {}

impl Hash for Device {
    fn hash<H: Hasher>(&self, state: &mut H) {
        discriminant(self).hash(state);
        self.name().hash(state);
    }
}

impl fmt::Display for Device {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let description = self.description().map_err(|_| fmt::Error)?;
        f.write_str(description.name())
    }
}

fn supported_ranges() -> Vec<SupportedStreamConfigRange> {
    let mut ranges = Vec::new();
    for format in FORMATS {
        for channels in 1..=2 {
            ranges.push(SupportedStreamConfigRange::new(
                channels,
                8_000,
                protocol::sample_spec::MAX_RATE,
                SupportedBufferSize::Unknown,
                *format,
            ));
        }
    }
    ranges
}

/// The device's own rate as float samples in at most two channels; the
/// server converts to and from the device's format.
fn default_config(spec: &protocol::SampleSpec) -> SupportedStreamConfig {
    SupportedStreamConfig::new(
        spec.channels.clamp(1, 2) as _,
        spec.sample_rate,
        SupportedBufferSize::Unknown,
        SampleFormat::F32,
    )
}

fn channel_map(channels: u16) -> protocol::ChannelMap {
    use protocol::ChannelPosition::*;
    if channels == 1 {
        protocol::ChannelMap::new([Mono])
    } else {
        protocol::ChannelMap::new([FrontLeft, FrontRight])
    }
}

fn stream_spec(config: &StreamConfig, format: SampleFormat) -> Result<protocol::SampleSpec, Error> {
    let format = pulse_format(format).ok_or_else(|| {
        Error::with_message(
            ErrorKind::UnsupportedConfig,
            format!("PulseAudio does not support sample format {format}"),
        )
    })?;
    if !(1..=2).contains(&config.channels) || config.sample_rate == 0 {
        return Err(Error::with_message(
            ErrorKind::UnsupportedConfig,
            "PulseAudio streams need one or two channels and a sample rate",
        ));
    }
    if config.buffer_size != BufferSize::Default {
        return Err(Error::with_message(
            ErrorKind::UnsupportedConfig,
            "PulseAudio streams use the helper's fixed latency",
        ));
    }
    Ok(protocol::SampleSpec {
        format,
        sample_rate: config.sample_rate,
        channels: config.channels as _,
    })
}

fn bytes(spec: &protocol::SampleSpec, duration: Duration) -> u32 {
    let frame = spec.channels as u128 * spec.format.bytes_per_sample() as u128;
    let frames = duration.as_micros() * spec.sample_rate as u128 / 1_000_000;
    (frames * frame).try_into().unwrap_or(u32::MAX)
}

// The server's default buffers hold about two seconds. These bound the
// latency end to end, as `adjust_latency` asks the server to, with room for
// a forwarded socket's jitter.
const RECORD_FRAGMENT: Duration = Duration::from_millis(20);
const PLAYBACK_TARGET: Duration = Duration::from_millis(80);
const PLAYBACK_REQUEST: Duration = Duration::from_millis(20);

fn record_buffer(spec: &protocol::SampleSpec) -> protocol::stream::BufferAttr {
    protocol::stream::BufferAttr {
        fragment_size: bytes(spec, RECORD_FRAGMENT),
        ..Default::default()
    }
}

fn playback_buffer(spec: &protocol::SampleSpec) -> protocol::stream::BufferAttr {
    protocol::stream::BufferAttr {
        target_length: bytes(spec, PLAYBACK_TARGET),
        minimum_request_length: bytes(spec, PLAYBACK_REQUEST),
        ..Default::default()
    }
}

/// Creates a stream within the server deadline, whatever cpal's caller asks.
fn create(
    connection: &Connection,
    build: impl FnOnce(Connection) -> Result<Stream, Error> + Send + 'static,
) -> Result<Stream, Error> {
    let owned = connection.clone();
    connection
        .call(move |_| build(owned))
        .unwrap_or_else(|| Err(timed_out()))
}

impl DeviceTrait for Device {
    type SupportedInputConfigs = std::vec::IntoIter<SupportedStreamConfigRange>;
    type SupportedOutputConfigs = std::vec::IntoIter<SupportedStreamConfigRange>;
    type Stream = Stream;

    fn supported_input_configs(&self) -> Result<Self::SupportedInputConfigs, Error> {
        Ok(match self {
            Device::Source { .. } => supported_ranges(),
            Device::Sink { .. } => Vec::new(),
        }
        .into_iter())
    }

    fn supported_output_configs(&self) -> Result<Self::SupportedOutputConfigs, Error> {
        Ok(match self {
            Device::Sink { .. } => supported_ranges(),
            Device::Source { .. } => Vec::new(),
        }
        .into_iter())
    }

    fn default_input_config(&self) -> Result<SupportedStreamConfig, Error> {
        match self {
            Device::Source { info, .. } => Ok(default_config(&info.sample_spec)),
            Device::Sink { .. } => Err(Error::with_message(
                ErrorKind::UnsupportedOperation,
                "PulseAudio sink does not support input",
            )),
        }
    }

    fn default_output_config(&self) -> Result<SupportedStreamConfig, Error> {
        match self {
            Device::Sink { info, .. } => Ok(default_config(&info.sample_spec)),
            Device::Source { .. } => Err(Error::with_message(
                ErrorKind::UnsupportedOperation,
                "PulseAudio source does not support output",
            )),
        }
    }

    fn build_input_stream_raw<D, E>(
        &self,
        config: StreamConfig,
        sample_format: SampleFormat,
        data_callback: D,
        error_callback: E,
        _timeout: Option<Duration>,
    ) -> Result<Self::Stream, Error>
    where
        D: FnMut(&Data, &InputCallbackInfo) + Send + 'static,
        E: FnMut(Error) + Send + 'static,
    {
        let Device::Source { connection, info } = self else {
            return Err(Error::with_message(
                ErrorKind::UnsupportedOperation,
                "PulseAudio sink does not support input",
            ));
        };
        let sample_spec = stream_spec(&config, sample_format)?;
        let params = protocol::RecordStreamParams {
            sample_spec,
            channel_map: channel_map(config.channels),
            source_index: Some(info.index),
            buffer_attr: record_buffer(&sample_spec),
            flags: protocol::stream::StreamFlags {
                start_corked: true,
                adjust_latency: true,
                ..Default::default()
            },
            ..Default::default()
        };
        let stream = create(connection, move |connection| {
            Stream::new_record(
                connection,
                params,
                sample_format,
                data_callback,
                error_callback,
            )
        })?;
        stream.signal_ready();
        Ok(stream)
    }

    fn build_output_stream_raw<D, E>(
        &self,
        config: StreamConfig,
        sample_format: SampleFormat,
        data_callback: D,
        error_callback: E,
        _timeout: Option<Duration>,
    ) -> Result<Self::Stream, Error>
    where
        D: FnMut(&mut Data, &OutputCallbackInfo) + Send + 'static,
        E: FnMut(Error) + Send + 'static,
    {
        let Device::Sink { connection, info } = self else {
            return Err(Error::with_message(
                ErrorKind::UnsupportedOperation,
                "PulseAudio source does not support output",
            ));
        };
        let sample_spec = stream_spec(&config, sample_format)?;
        let params = protocol::PlaybackStreamParams {
            sink_index: Some(info.index),
            sample_spec,
            channel_map: channel_map(config.channels),
            buffer_attr: playback_buffer(&sample_spec),
            flags: protocol::stream::StreamFlags {
                start_corked: true,
                adjust_latency: true,
                ..Default::default()
            },
            ..Default::default()
        };
        let stream = create(connection, move |connection| {
            Stream::new_playback(
                connection,
                params,
                sample_format,
                data_callback,
                error_callback,
            )
        })?;
        stream.signal_ready();
        Ok(stream)
    }

    fn description(&self) -> Result<DeviceDescription, Error> {
        let (name, description, direction) = match self {
            Device::Sink { info, .. } => (&info.name, &info.description, DeviceDirection::Output),
            Device::Source { info, .. } => (&info.name, &info.description, DeviceDirection::Input),
        };
        let label = String::from_utf8_lossy(description.as_ref().unwrap_or(name).as_bytes());
        Ok(
            DeviceDescriptionBuilder::new(format!("{label} (PulseAudio)"))
                .direction(direction)
                .build(),
        )
    }

    fn id(&self) -> Result<DeviceId, Error> {
        Ok(DeviceId::new(
            cpal::HostId::Custom,
            format!("pulse:{}", String::from_utf8_lossy(self.name().to_bytes())),
        ))
    }
}

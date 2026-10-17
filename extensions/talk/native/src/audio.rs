use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{
    Device, ErrorKind, FromSample, Sample, SampleFormat, SizedSample, Stream, SupportedStreamConfig,
};
use crossbeam_queue::ArrayQueue;
use tokio::sync::mpsc;

use crate::codex_audio::buffers::{BLOCK, CaptureBoundary, Frame, FramePacker};
use crate::playout::{PlayoutMark, PlayoutProbe};
use crate::protocol::{AudioDevice, Event, MAX_DEVICE_BYTES, MAX_DEVICES, MAX_SAFE_INTEGER};

const CAPTURE_QUEUE_FRAMES: usize = 192;
const RENDER_QUEUE_FRAMES: usize = 192;
const PLAYBACK_QUEUE_MS: usize = 500;
// One jitter budget per call: `playout.rs` holds START_PACKETS for RTP
// reorder protection, so the device starts with only enough queued audio to
// cover its callback period. Each underrun in the call raises the threshold
// one step, up to the maximum; a new call starts low again. Only an empty
// queue while the producer still holds RTP packets counts as an underrun; the
// end of a response or a network stall is ambiguous and never raises it.
const PLAYBACK_START_MS: usize = 40;
const PLAYBACK_START_STEP_MS: usize = 40;
const PLAYBACK_START_MAX_MS: usize = 120;
const ACTIVITY_INTERVAL: Duration = Duration::from_millis(100);
const ACTIVITY_THRESHOLD: f32 = 0.0001;

pub struct Capture {
    _stream: Stream,
    pub frames: Arc<ArrayQueue<Frame>>,
    pub sample_rate: u32,
    pub generation: Arc<AtomicU64>,
    pub dropped: Arc<AtomicBool>,
    pub failed: Arc<AtomicBool>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SpeakerControl {
    pub epoch: u64,
    pub suppressed: bool,
}

impl SpeakerControl {
    pub fn accepts_packet(self, desired: Self) -> bool {
        !self.suppressed && self == desired
    }
}

pub struct SpeakerState {
    packed: AtomicU64,
}

impl SpeakerState {
    pub fn new() -> Self {
        Self {
            packed: AtomicU64::new(0),
        }
    }

    pub fn get(&self) -> SpeakerControl {
        let packed = self.packed.load(Ordering::Acquire);
        SpeakerControl {
            epoch: packed >> 1,
            suppressed: packed & 1 == 1,
        }
    }

    pub fn transition(&self, suppressed: bool, epoch: u64) -> Result<SpeakerControl> {
        if epoch > MAX_SAFE_INTEGER {
            anyhow::bail!("speaker epoch exceeds the JavaScript safe integer range");
        }
        let current = self.get();
        if epoch <= current.epoch {
            anyhow::bail!("speaker epoch must increase on every transition");
        }
        if suppressed == current.suppressed {
            anyhow::bail!("speaker suppression command does not describe a transition");
        }
        let next = SpeakerControl { epoch, suppressed };
        self.packed
            .compare_exchange(
                (current.epoch << 1) | u64::from(current.suppressed),
                (epoch << 1) | u64::from(suppressed),
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .map_err(|_| anyhow::anyhow!("concurrent speaker transition"))?;
        Ok(next)
    }
}

#[derive(Clone, Copy)]
pub struct PlaybackSample {
    pub value: f32,
    pub epoch: u64,
}

/// Decoded speaker audio plus the playout state that spans one call: the
/// adaptive start threshold and diagnostics survive output stream rebuilds.
pub struct PlaybackBuffer {
    samples: ArrayQueue<PlaybackSample>,
    start_ms: AtomicUsize,
    // Low bit: the producer is mid-stream, with RTP packets buffered behind
    // the frame it just queued. Upper bits count such runs, so a stream that
    // went idle and restarted never looks continuous.
    stream: AtomicU64,
    pub probe: PlayoutProbe,
}

impl PlaybackBuffer {
    fn new(capacity: usize) -> Self {
        Self {
            samples: ArrayQueue::new(capacity),
            start_ms: AtomicUsize::new(PLAYBACK_START_MS),
            stream: AtomicU64::new(0),
            probe: PlayoutProbe::new(),
        }
    }

    fn push(&self, sample: PlaybackSample) {
        push_latest(&self.samples, sample);
    }

    /// Queues decoded samples for `epoch`. The enqueue mark is recorded as
    /// soon as the first sample is visible to the output callback.
    pub fn enqueue(&self, values: impl IntoIterator<Item = f32>, epoch: u64) {
        let mut values = values.into_iter();
        let Some(value) = values.next() else {
            return;
        };
        self.push(PlaybackSample { value, epoch });
        self.probe.mark(PlayoutMark::Enqueue, epoch, Instant::now());
        for value in values {
            self.push(PlaybackSample { value, epoch });
        }
    }

    // Only the playout task writes the stream state.
    pub fn set_streaming(&self, streaming: bool) {
        let current = self.stream.load(Ordering::Relaxed);
        let next = match (current & 1 == 1, streaming) {
            (false, true) => (current | 1) + 2,
            (true, false) => current & !1,
            _ => return,
        };
        self.stream.store(next, Ordering::Release);
    }

    fn stream_state(&self) -> u64 {
        self.stream.load(Ordering::Acquire)
    }

    fn pop(&self) -> Option<PlaybackSample> {
        self.samples.pop()
    }

    fn clear(&self) {
        clear(&self.samples);
    }

    pub fn start_threshold_ms(&self) -> usize {
        self.start_ms.load(Ordering::Relaxed)
    }

    // Only the single live output callback raises the threshold.
    fn record_underrun(&self) {
        let raised =
            (self.start_threshold_ms() + PLAYBACK_START_STEP_MS).min(PLAYBACK_START_MAX_MS);
        self.start_ms.store(raised, Ordering::Relaxed);
        self.probe.underrun();
    }

    /// The stats event owed after an output callback: the epoch's first
    /// nonzero output, or an underrun counted during the callback.
    fn output_stats(
        &self,
        epoch: u64,
        nonzero: bool,
        underruns_before: u64,
        now: Instant,
    ) -> Option<Event> {
        let first_output = nonzero && self.probe.mark(PlayoutMark::Output, epoch, now);
        (first_output || self.probe.underruns() != underruns_before)
            .then(|| self.probe.stats(epoch, self.start_threshold_ms() as u64))
    }
}

/// Start/stop state for one output stream. A stream rebuilt after a spoken
/// interruption starts from the call's current threshold.
#[derive(Default)]
struct OutputGate {
    playing: bool,
    // The producer's stream run that was mid-stream when the queue ran dry.
    starved_in: Option<u64>,
}

impl OutputGate {
    /// Returns the next sample for `epoch`, or silence while buffering.
    fn next_sample(&mut self, buffer: &PlaybackBuffer, sample_rate: u32, epoch: u64) -> f32 {
        if !self.admit(buffer, sample_rate) {
            return 0.0;
        }
        loop {
            match buffer.pop() {
                Some(sample) if sample.epoch == epoch => return sample.value,
                Some(_) => continue,
                None => {
                    self.starved(buffer);
                    return 0.0;
                }
            }
        }
    }

    /// Returns whether the callback should take the next queued sample.
    fn admit(&mut self, buffer: &PlaybackBuffer, sample_rate: u32) -> bool {
        if self.playing {
            return true;
        }
        let queued = buffer.samples.len();
        if queued > 0
            && let Some(run) = self.starved_in.take()
            && buffer.stream_state() == run
        {
            buffer.record_underrun();
        }
        self.playing = queued >= sample_rate as usize * buffer.start_threshold_ms() / 1_000;
        self.playing
    }

    fn starved(&mut self, buffer: &PlaybackBuffer) {
        self.playing = false;
        let stream = buffer.stream_state();
        self.starved_in = (stream & 1 == 1).then_some(stream);
    }
}

pub struct Playback {
    stream: Option<Stream>,
    device: Device,
    supported: SupportedStreamConfig,
    events: mpsc::Sender<Event>,
    pub samples: Arc<PlaybackBuffer>,
    pub rendered: Arc<ArrayQueue<Frame>>,
    pub render_dropped: Arc<AtomicBool>,
    pub sample_rate: u32,
    pub state: Arc<SpeakerState>,
}

#[derive(Clone)]
struct OutputShared {
    samples: Arc<PlaybackBuffer>,
    rendered: Arc<ArrayQueue<Frame>>,
    render_dropped: Arc<AtomicBool>,
    state: Arc<SpeakerState>,
    events: mpsc::Sender<Event>,
}

/// Local adaptation: use only the system CoreAudio host on macOS.
fn hosts() -> Vec<cpal::Host> {
    vec![cpal::default_host()]
}

type DeviceList = Box<dyn Iterator<Item = Device>>;

/// Lists each host's devices. Only the last, system host's errors are
/// returned: an optional host that fails, such as a PulseAudio server that
/// went away, never hides the system's own devices.
fn host_devices(hosts: &[cpal::Host], input: bool) -> Result<Vec<DeviceList>> {
    let mut lists = Vec::with_capacity(hosts.len());
    for (index, host) in hosts.iter().enumerate() {
        let list = if input {
            host.input_devices()
                .map(|devices| Box::new(devices) as DeviceList)
        } else {
            host.output_devices()
                .map(|devices| Box::new(devices) as DeviceList)
        };
        match list {
            Ok(list) => lists.push(list),
            Err(error) if index + 1 == hosts.len() => return Err(error.into()),
            Err(_) => {}
        }
    }
    Ok(lists)
}

fn find_device(hosts: &[cpal::Host], id: &str, input: bool) -> Result<Option<Device>> {
    Ok(host_devices(hosts, input)?
        .into_iter()
        .flatten()
        .find(|device| {
            device
                .id()
                .is_ok_and(|candidate| candidate.to_string() == id)
        }))
}

pub fn devices() -> Result<(Vec<AudioDevice>, Vec<AudioDevice>)> {
    let hosts = hosts();
    let default_input_id = hosts
        .iter()
        .find_map(|host| host.default_input_device())
        .and_then(|device| device.id().ok());
    let default_output_id = hosts
        .iter()
        .find_map(|host| host.default_output_device())
        .and_then(|device| device.id().ok());
    let inputs = host_devices(&hosts, true)?
        .into_iter()
        .flatten()
        .filter_map(|device| describe_device(device, default_input_id.as_ref()))
        .take(MAX_DEVICES)
        .collect();
    let outputs = host_devices(&hosts, false)?
        .into_iter()
        .flatten()
        .filter_map(|device| describe_device(device, default_output_id.as_ref()))
        .take(MAX_DEVICES)
        .collect();
    Ok((inputs, outputs))
}

fn describe_device(device: Device, default_id: Option<&cpal::DeviceId>) -> Option<AudioDevice> {
    let id = device.id().ok()?;
    let id = id.to_string();
    if id.len() > MAX_DEVICE_BYTES {
        return None;
    }
    let mut name = device
        .description()
        .map(|description| description.name().to_owned())
        .unwrap_or_else(|_| id.clone());
    while name.len() > MAX_DEVICE_BYTES {
        name.pop();
    }
    Some(AudioDevice {
        is_default: default_id.is_some_and(|candidate| candidate.to_string() == id),
        name,
        id,
    })
}

pub fn capture(device_id: Option<&str>) -> Result<Capture> {
    let hosts = hosts();
    if let Some(id) = device_id {
        let device = find_device(&hosts, id, true)?.context("no microphone device available")?;
        return capture_device(device);
    }
    let device = hosts
        .iter()
        .find_map(|host| host.default_input_device())
        .context("no default microphone configured")?;
    capture_device(device).context("failed to open the default microphone")
}

fn capture_device(device: Device) -> Result<Capture> {
    let supported = device
        .default_input_config()
        .context("microphone has no default input format")?;
    validate_config(&supported)?;
    let sample_rate = supported.sample_rate();
    let frames = Arc::new(ArrayQueue::new(CAPTURE_QUEUE_FRAMES));
    let generation = Arc::new(AtomicU64::new(0));
    let dropped = Arc::new(AtomicBool::new(false));
    let failed = Arc::new(AtomicBool::new(false));
    let stream = build_input_stream(
        &device,
        &supported,
        Arc::clone(&frames),
        Arc::clone(&generation),
        Arc::clone(&dropped),
        Arc::clone(&failed),
    )?;
    stream.play().context("failed to start microphone")?;
    Ok(Capture {
        _stream: stream,
        frames,
        sample_rate,
        generation,
        dropped,
        failed,
    })
}

pub fn playback(device_id: Option<&str>, events: mpsc::Sender<Event>) -> Result<Playback> {
    let hosts = hosts();
    let device = if let Some(id) = device_id {
        find_device(&hosts, id, false)?.context("no speaker device available")?
    } else {
        hosts
            .iter()
            .find_map(|host| host.default_output_device())
            .context("no default speaker configured")?
    };
    playback_device(device, events).context("failed to open the speaker")
}

fn playback_device(device: Device, events: mpsc::Sender<Event>) -> Result<Playback> {
    let supported = device
        .default_output_config()
        .context("speaker has no default output format")?;
    validate_config(&supported)?;
    let sample_rate = supported.sample_rate();
    let mut playback = Playback {
        stream: None,
        device,
        supported,
        events,
        samples: Arc::new(PlaybackBuffer::new(
            sample_rate as usize * PLAYBACK_QUEUE_MS / 1_000,
        )),
        rendered: Arc::new(ArrayQueue::new(RENDER_QUEUE_FRAMES)),
        render_dropped: Arc::new(AtomicBool::new(false)),
        sample_rate,
        state: Arc::new(SpeakerState::new()),
    };
    playback.restart()?;
    Ok(playback)
}

impl Playback {
    pub fn transition(&mut self, suppressed: bool, epoch: u64) -> Result<SpeakerControl> {
        let next = self.state.transition(suppressed, epoch)?;
        drop(self.stream.take());
        self.samples.clear();
        clear(&self.rendered);
        self.render_dropped.store(false, Ordering::Release);
        if !suppressed {
            self.restart()?;
        }
        Ok(next)
    }

    fn restart(&mut self) -> Result<()> {
        let stream = build_output_stream(
            &self.device,
            &self.supported,
            OutputShared {
                samples: Arc::clone(&self.samples),
                rendered: Arc::clone(&self.rendered),
                render_dropped: Arc::clone(&self.render_dropped),
                state: Arc::clone(&self.state),
                events: self.events.clone(),
            },
        )?;
        stream.play().context("failed to start speaker")?;
        self.stream = Some(stream);
        Ok(())
    }
}

fn build_input_stream(
    device: &Device,
    supported: &SupportedStreamConfig,
    queue: Arc<ArrayQueue<Frame>>,
    generation: Arc<AtomicU64>,
    dropped: Arc<AtomicBool>,
    failed: Arc<AtomicBool>,
) -> Result<Stream> {
    let channels = supported.channels() as usize;
    let config = (*supported).into();
    let stream = match supported.sample_format() {
        SampleFormat::F32 => input_stream::<f32>(
            device, &config, channels, queue, generation, dropped, failed,
        ),
        SampleFormat::I16 => input_stream::<i16>(
            device, &config, channels, queue, generation, dropped, failed,
        ),
        SampleFormat::U16 => input_stream::<u16>(
            device, &config, channels, queue, generation, dropped, failed,
        ),
        format => anyhow::bail!("unsupported microphone sample format {format}"),
    }?;
    Ok(stream)
}

fn input_stream<T>(
    device: &Device,
    config: &cpal::StreamConfig,
    channels: usize,
    queue: Arc<ArrayQueue<Frame>>,
    generation: Arc<AtomicU64>,
    dropped: Arc<AtomicBool>,
    failed: Arc<AtomicBool>,
) -> Result<Stream, cpal::Error>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let rate = f64::from(config.sample_rate);
    let failure = Arc::clone(&failed);
    let mut origin = None;
    let mut boundary = CaptureBoundary::default();
    let mut capture = FramePacker::default();
    device.build_input_stream(
        *config,
        move |input: &[T], info: &cpal::InputCallbackInfo| {
            let current = generation.load(Ordering::Acquire);
            if current % 2 == 1 {
                capture.reset();
                return;
            }
            let timestamp = info.timestamp();
            let origin = origin.get_or_insert(timestamp.capture);
            let (Some(callback), Some(captured)) = (
                timestamp.callback.checked_duration_since(*origin),
                timestamp.capture.checked_duration_since(*origin),
            ) else {
                capture.reset();
                return;
            };
            if !boundary.accepts(current, callback, captured) {
                capture.reset();
                return;
            }
            let start = Instant::now()
                .checked_sub(
                    timestamp
                        .callback
                        .checked_duration_since(timestamp.capture)
                        .unwrap_or_default(),
                )
                .unwrap_or_else(Instant::now);
            capture.discard_capture_gap(start, rate);
            for (index, chunk) in input.chunks(BLOCK * channels).enumerate() {
                let mut frame = Frame {
                    samples: [0.0; BLOCK],
                    len: chunk.len() / channels,
                    at: start + Duration::from_secs_f64((index * BLOCK) as f64 / rate),
                    generation: current,
                };
                for (output, source) in frame.samples.iter_mut().zip(chunk.chunks_exact(channels)) {
                    *output = source
                        .iter()
                        .map(|sample| f32::from_sample(*sample))
                        .sum::<f32>()
                        / channels as f32;
                    if !output.is_finite() {
                        failure.store(true, Ordering::Release);
                        capture.reset();
                        return;
                    }
                }
                if !capture.push(frame, rate, &queue) {
                    capture.reset();
                    dropped.store(true, Ordering::Release);
                    return;
                }
            }
        },
        move |error| {
            eprintln!("microphone stream error: {error}");
            if error.kind() != ErrorKind::Xrun {
                failed.store(true, Ordering::Release);
            }
        },
        None,
    )
}

fn build_output_stream(
    device: &Device,
    supported: &SupportedStreamConfig,
    shared: OutputShared,
) -> Result<Stream> {
    let channels = supported.channels() as usize;
    let config = (*supported).into();
    let stream = match supported.sample_format() {
        SampleFormat::F32 => output_stream::<f32>(device, &config, channels, shared),
        SampleFormat::I16 => output_stream::<i16>(device, &config, channels, shared),
        SampleFormat::U16 => output_stream::<u16>(device, &config, channels, shared),
        format => anyhow::bail!("unsupported speaker sample format {format}"),
    }?;
    Ok(stream)
}

fn output_stream<T>(
    device: &Device,
    config: &cpal::StreamConfig,
    channels: usize,
    shared: OutputShared,
) -> Result<Stream, cpal::Error>
where
    T: SizedSample + FromSample<f32>,
    f32: FromSample<T>,
{
    let OutputShared {
        samples,
        rendered,
        render_dropped,
        state,
        events,
    } = shared;
    let sample_rate = config.sample_rate;
    let rate = f64::from(sample_rate);
    let activity_events = events.clone();
    let mut gate = OutputGate::default();
    let mut reference = FramePacker::default();
    let mut last_activity = None;
    let mut error_reported = false;
    device.build_output_stream(
        *config,
        move |output: &mut [T], info: &cpal::OutputCallbackInfo| {
            let control = state.get();
            let now = Instant::now();
            let underruns = samples.probe.underruns();
            let mut nonzero = false;
            let timestamp = info.timestamp();
            let start = Instant::now()
                + timestamp
                    .playback
                    .checked_duration_since(timestamp.callback)
                    .unwrap_or_default();
            let mut active = false;
            for (index, chunk) in output.chunks_mut(BLOCK * channels).enumerate() {
                let mut rendered_frame = Frame {
                    samples: [0.0; BLOCK],
                    len: chunk.len() / channels,
                    at: start + Duration::from_secs_f64((index * BLOCK) as f64 / rate),
                    generation: control.epoch,
                };
                for (frame, reference_sample) in
                    chunk.chunks_mut(channels).zip(&mut rendered_frame.samples)
                {
                    let sample = if control.suppressed {
                        0.0
                    } else {
                        gate.next_sample(&samples, sample_rate, control.epoch)
                    };
                    let sample = if sample.is_finite() {
                        sample.clamp(-1.0, 1.0)
                    } else {
                        0.0
                    };
                    let actual = T::from_sample(sample);
                    frame.fill(actual);
                    *reference_sample = f32::from_sample(actual);
                    nonzero |= *reference_sample != 0.0;
                    active |= reference_sample.abs() >= ACTIVITY_THRESHOLD;
                }
                if !reference.push(rendered_frame, rate, &rendered) {
                    reference.reset();
                    render_dropped.store(true, Ordering::Release);
                }
            }
            if let Some(stats) = samples.output_stats(control.epoch, nonzero, underruns, now) {
                let _ = activity_events.try_send(stats);
            }
            if active
                && last_activity.is_none_or(|last| now.duration_since(last) >= ACTIVITY_INTERVAL)
                && activity_events.try_send(Event::PlaybackActivity).is_ok()
            {
                last_activity = Some(now);
            }
        },
        move |error| {
            eprintln!("speaker stream error: {error}");
            if error.kind() != ErrorKind::DeviceChanged && !error_reported {
                error_reported = true;
                let _ = events.try_send(Event::Error {
                    message: format!("speaker stream error: {error}"),
                });
            }
        },
        None,
    )
}

fn validate_config(config: &SupportedStreamConfig) -> Result<()> {
    if config.channels() == 0 || !(8_000..=384_000).contains(&config.sample_rate()) {
        anyhow::bail!("unsupported audio device configuration");
    }
    Ok(())
}

pub fn push_latest<T>(queue: &ArrayQueue<T>, value: T) {
    if let Err(value) = queue.push(value) {
        let _ = queue.pop();
        let _ = queue.push(value);
    }
}

pub fn clear<T>(queue: &ArrayQueue<T>) {
    for _ in 0..queue.capacity() {
        if queue.pop().is_none() {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::task::Poll;

    use super::*;

    #[tokio::test]
    async fn audio_queues_generations_and_sends_have_hard_boundaries() {
        let queue = ArrayQueue::new(2);
        push_latest(&queue, 1.0);
        push_latest(&queue, 2.0);
        push_latest(&queue, 3.0);
        assert_eq!(queue.pop(), Some(2.0));
        assert_eq!(queue.pop(), Some(3.0));

        let state = SpeakerState::new();
        let initial = state.get();
        assert!(initial.accepts_packet(initial));
        assert_eq!(
            state.transition(true, 1).unwrap(),
            SpeakerControl {
                epoch: 1,
                suppressed: true,
            }
        );
        assert!(!initial.accepts_packet(state.get()));
        assert!(state.transition(false, 1).is_err());
        let resumed = state.transition(false, 2).unwrap();
        assert_eq!(
            resumed,
            SpeakerControl {
                epoch: 2,
                suppressed: false,
            }
        );
        assert!(resumed.accepts_packet(state.get()));

        let mut boundary = CaptureBoundary::default();
        for (generation, callback_ms, capture_ms, accepted) in [
            (1, 20, 10, false),
            (2, 21, 15, false),
            (2, 25, 22, false),
            (2, 27, 25, true),
            (4, 30, 29, false),
            (4, 34, 31, false),
            (4, 36, 34, true),
        ] {
            assert_eq!(
                boundary.accepts(
                    generation,
                    Duration::from_millis(callback_ms),
                    Duration::from_millis(capture_ms),
                ),
                accepted,
            );
        }

        assert!(
            crate::v3_media::with_send_deadline(std::future::pending::<()>())
                .await
                .is_err()
        );

        fn queued_read(
            remaining: Arc<std::sync::atomic::AtomicUsize>,
        ) -> impl std::future::Future<Output = std::result::Result<(), ()>> {
            std::future::poll_fn(move |_| {
                remaining
                    .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                        count.checked_sub(1)
                    })
                    .map_or(Poll::Pending, |_| Poll::Ready(Ok(())))
            })
        }

        let budget = crate::v3_media::TRANSITION_DRAIN_PACKET_BUDGET;
        let remaining = Arc::new(std::sync::atomic::AtomicUsize::new(budget));
        let mut read = Box::pin(queued_read(Arc::clone(&remaining)));
        assert_eq!(
            crate::v3_media::drain_ready_packets(&mut read, || {
                Box::pin(queued_read(Arc::clone(&remaining)))
            }),
            crate::v3_media::ReadyDrain::Pending
        );
        assert_eq!(remaining.load(Ordering::Acquire), 0);
        remaining.store(1, Ordering::Release);
        assert_eq!(
            crate::v3_media::drain_ready_packets(&mut read, || {
                Box::pin(queued_read(Arc::clone(&remaining)))
            }),
            crate::v3_media::ReadyDrain::Pending
        );
        assert_eq!(remaining.load(Ordering::Acquire), 0);

        let remaining = Arc::new(std::sync::atomic::AtomicUsize::new(budget + 1));
        let mut read = Box::pin(queued_read(Arc::clone(&remaining)));
        assert_eq!(
            crate::v3_media::drain_ready_packets(&mut read, || {
                Box::pin(queued_read(Arc::clone(&remaining)))
            }),
            crate::v3_media::ReadyDrain::Exhausted
        );
    }

    const RATE: u32 = 48_000;

    fn fill(buffer: &PlaybackBuffer, ms: usize) {
        for _ in 0..RATE as usize * ms / 1_000 {
            buffer.push(PlaybackSample {
                value: 0.5,
                epoch: 0,
            });
        }
    }

    fn drain_all(buffer: &PlaybackBuffer) {
        while buffer.pop().is_some() {}
    }

    /// Feeds steady packets through the real RTP playout and device gate and
    /// returns the millisecond at which the first sample may reach the device.
    fn first_sample_eligibility_ms(packet_ms: u64, start_ms: Option<usize>) -> u64 {
        use crate::playout::{PacketPlayout, PlayoutClock, PlayoutFrame};

        let buffer = PlaybackBuffer::new(RATE as usize);
        if let Some(start_ms) = start_ms {
            buffer.start_ms.store(start_ms, Ordering::Relaxed);
        }
        let mut gate = OutputGate::default();
        let base = tokio::time::Instant::now();
        let mut playout = PacketPlayout::new();
        let mut clock = PlayoutClock::new();
        for now in 0..1_000 {
            let at = base + Duration::from_millis(now);
            if now % packet_ms == 0 {
                playout.push((now / packet_ms) as u16, bytes::Bytes::from_static(&[1]));
                if playout.ready() {
                    clock.start(at);
                }
            }
            while clock.deadline().is_some_and(|deadline| deadline <= at) {
                match playout.next() {
                    PlayoutFrame::Packet(_) => {
                        fill(&buffer, packet_ms as usize);
                        clock.advance(48 * packet_ms as usize, RATE);
                    }
                    _ => clock.stop(),
                }
            }
            if gate.admit(&buffer, RATE) {
                return now;
            }
        }
        panic!("playout never started");
    }

    #[test]
    fn one_jitter_budget_starts_sooner_than_the_stacked_prebuffers() {
        const STACKED_START_MS: usize = 100;
        for (packet_ms, stacked, adaptive) in [(10, 110, 50), (20, 120, 60), (40, 160, 80)] {
            assert_eq!(
                first_sample_eligibility_ms(packet_ms, Some(STACKED_START_MS)),
                stacked,
                "{packet_ms} ms packets with the stacked threshold"
            );
            assert_eq!(
                first_sample_eligibility_ms(packet_ms, None),
                adaptive,
                "{packet_ms} ms packets with the adaptive threshold"
            );
        }
    }

    /// Plays 20 ms packets arriving at `arrivals` (ms, sequence) through the
    /// real RTP playout, producer stream signal, and output gate, with a device
    /// that takes `quantum` samples per callback at the real-time rate. Returns
    /// the buffer and the longest silence between audible callbacks in ms.
    fn simulate(arrivals: &[(u64, u16)], quantum: usize) -> (PlaybackBuffer, u64) {
        use crate::playout::{PacketPlayout, PlayoutClock, PlayoutFrame};

        const PACKET_SAMPLES: usize = 960;
        let buffer = PlaybackBuffer::new(RATE as usize);
        let mut gate = OutputGate::default();
        let base = tokio::time::Instant::now();
        let mut playout = PacketPlayout::new();
        let mut clock = PlayoutClock::new();
        let mut callbacks = 0;
        let mut last_audible = None;
        let mut longest_silence = 0;
        let end = arrivals.iter().map(|(at, _)| *at).max().unwrap_or(0) + 500;
        for now in 0..end {
            let at = base + Duration::from_millis(now);
            for (_, sequence) in arrivals.iter().filter(|(arrival, _)| *arrival == now) {
                playout.push(*sequence, bytes::Bytes::from_static(&[1]));
                if playout.ready() {
                    clock.start(at);
                }
            }
            while clock.deadline().is_some_and(|deadline| deadline <= at) {
                if playout.next() == PlayoutFrame::Buffering {
                    clock.stop();
                    buffer.set_streaming(false);
                } else {
                    buffer.set_streaming(playout.has_buffered());
                    buffer.enqueue(std::iter::repeat_n(0.5, PACKET_SAMPLES), 0);
                    clock.advance(PACKET_SAMPLES, RATE);
                }
            }
            while callbacks * quantum <= now as usize * RATE as usize / 1_000 {
                let mut audible = false;
                for _ in 0..quantum {
                    audible |= gate.next_sample(&buffer, RATE, 0) != 0.0;
                }
                if audible {
                    if let Some(last) = last_audible {
                        longest_silence = longest_silence.max(now - last);
                    }
                    last_audible = Some(now);
                }
                callbacks += 1;
            }
        }
        (buffer, longest_silence)
    }

    fn steady(from_ms: u64, sequences: std::ops::Range<u16>) -> Vec<(u64, u16)> {
        sequences
            .enumerate()
            .map(|(index, sequence)| (from_ms + index as u64 * 20, sequence))
            .collect()
    }

    #[test]
    fn a_short_natural_gap_between_responses_keeps_the_threshold() {
        // The first response ends, playout goes idle, and the next response
        // starts so soon that the device resumes within 200 ms of running dry.
        let mut arrivals = steady(0, 0..10);
        arrivals.extend(steady(300, 10..20));
        let (buffer, longest_silence) = simulate(&arrivals, 480);
        assert!(
            (20..=200).contains(&longest_silence),
            "the device ran dry and resumed within 200 ms ({longest_silence} ms)"
        );
        assert_eq!(buffer.probe.underruns(), 0);
        assert_eq!(buffer.start_threshold_ms(), PLAYBACK_START_MS);
    }

    #[test]
    fn device_starvation_mid_stream_raises_the_threshold() {
        // An 85 ms (4,096-sample) callback outgrows the 40 and 80 ms start
        // thresholds while the producer still holds RTP packets; 120 ms holds.
        let (buffer, _) = simulate(&steady(0, 0..50), 4_096);
        assert_eq!(buffer.probe.underruns(), 2);
        assert_eq!(buffer.start_threshold_ms(), PLAYBACK_START_MAX_MS);
    }

    #[test]
    fn device_threshold_rises_only_after_underruns_and_resets_per_call() {
        let buffer = PlaybackBuffer::new(RATE as usize);
        let mut gate = OutputGate::default();
        buffer.set_streaming(true);

        fill(&buffer, PLAYBACK_START_MS - 1);
        assert!(!gate.admit(&buffer, RATE));
        fill(&buffer, 1);
        assert!(gate.admit(&buffer, RATE));

        // Running dry while the producer is mid-stream is an underrun.
        for expected in [80, 120, PLAYBACK_START_MAX_MS] {
            drain_all(&buffer);
            gate.starved(&buffer);
            fill(&buffer, 20);
            assert!(!gate.admit(&buffer, RATE));
            assert_eq!(buffer.start_threshold_ms(), expected);
            fill(&buffer, expected - 20);
            assert!(gate.admit(&buffer, RATE));
        }
        assert_eq!(buffer.probe.underruns(), 3);

        // Running dry after the producer went idle is the end of a response.
        buffer.set_streaming(false);
        drain_all(&buffer);
        gate.starved(&buffer);
        buffer.set_streaming(true);
        fill(&buffer, PLAYBACK_START_MAX_MS);
        assert!(gate.admit(&buffer, RATE));
        assert_eq!(buffer.probe.underruns(), 3);

        let next_call = PlaybackBuffer::new(RATE as usize);
        assert_eq!(next_call.start_threshold_ms(), PLAYBACK_START_MS);
        assert_eq!(next_call.probe.underruns(), 0);
    }

    #[test]
    fn running_dry_across_a_stream_restart_is_not_an_underrun() {
        let buffer = PlaybackBuffer::new(RATE as usize);
        let mut gate = OutputGate::default();
        buffer.set_streaming(true);
        fill(&buffer, PLAYBACK_START_MS);
        for _ in 0..=RATE as usize * PLAYBACK_START_MS / 1_000 {
            gate.next_sample(&buffer, RATE, 0);
        }

        // The queue ran dry mid-stream, but the stream then ended and a new
        // one began before audio resumed: the boundary is ambiguous.
        buffer.set_streaming(false);
        buffer.set_streaming(true);
        fill(&buffer, PLAYBACK_START_MS);
        assert!(gate.admit(&buffer, RATE));
        assert_eq!(buffer.probe.underruns(), 0);
        assert_eq!(buffer.start_threshold_ms(), PLAYBACK_START_MS);
    }

    #[test]
    fn interruption_recovery_reuses_the_current_threshold() {
        let buffer = PlaybackBuffer::new(RATE as usize);
        let mut gate = OutputGate::default();
        buffer.set_streaming(true);
        fill(&buffer, PLAYBACK_START_MS);
        assert!(gate.admit(&buffer, RATE));

        // A spoken interruption clears the queue and rebuilds the output stream.
        buffer.clear();
        let mut rebuilt = OutputGate::default();
        fill(&buffer, PLAYBACK_START_MS - 1);
        assert!(!rebuilt.admit(&buffer, RATE));
        fill(&buffer, 1);
        assert!(rebuilt.admit(&buffer, RATE));

        // An earned higher threshold carries across the rebuild, unchanged.
        drain_all(&buffer);
        gate.starved(&buffer);
        fill(&buffer, 1);
        assert!(!gate.admit(&buffer, RATE));
        let raised = buffer.start_threshold_ms();
        buffer.clear();
        let mut rebuilt = OutputGate::default();
        fill(&buffer, raised - 1);
        assert!(!rebuilt.admit(&buffer, RATE));
        fill(&buffer, 1);
        assert!(rebuilt.admit(&buffer, RATE));
        assert_eq!(buffer.probe.underruns(), 1);
    }

    #[test]
    fn first_output_snapshot_includes_the_first_enqueue() {
        let buffer = PlaybackBuffer::new(RATE as usize);
        buffer.probe.begin(7, Instant::now());
        let mut gate = OutputGate::default();
        let threshold = RATE as usize * PLAYBACK_START_MS / 1_000;
        let mut snapshot = None;
        // A 60 ms packet exceeds the start threshold, so the output callback
        // runs while the producer is still queueing the rest of the packet.
        let packet = (0..RATE as usize * 60 / 1_000).map(|index| {
            if index == threshold {
                let underruns = buffer.probe.underruns();
                let nonzero = gate.next_sample(&buffer, RATE, 7) != 0.0;
                snapshot = buffer.output_stats(7, nonzero, underruns, Instant::now());
            }
            0.5
        });
        buffer.enqueue(packet, 7);
        let snapshot = serde_json::to_value(snapshot.expect("first output snapshot")).unwrap();
        assert!(snapshot["first_output_us"].is_u64());
        assert!(snapshot["first_enqueue_us"].is_u64(), "{snapshot}");
    }
}

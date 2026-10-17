mod audio;
mod codex_audio;
mod playout;
mod protocol;
mod resample;
mod v3;
mod v3_media;

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use protocol::{Command, Event, PROTOCOL_VERSION};
use tokio::io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{Notify, mpsc};

/// Producers hand events to the router through this channel; the router drains
/// it without waiting on stdout, so it only fills while control is saturated.
const EVENT_CHANNEL_CAPACITY: usize = 256;
/// Reliable state, data, and error events waiting for stdout. Ordered, never dropped.
const CONTROL_EVENT_CAPACITY: usize = 256;
/// PCM events waiting for stdout (2.56 s of 20 ms frames); the oldest is dropped first.
const MEDIA_EVENT_CAPACITY: usize = 128;
/// Realtime playback PCM older than this is dropped instead of written late.
const REALTIME_PCM_MAX_AGE: Duration = Duration::from_millis(200);
/// Dictation PCM tolerates a longer reader stall because every frame is transcribed.
/// It also bounds the drain of accepted dictation audio ahead of a stop acknowledgement.
const DICTATION_PCM_MAX_AGE: Duration = Duration::from_secs(2);
const DICTATION_AUDIO_LOST: &str =
    "dictation audio was dropped because the voice helper output stalled";
const DICTATION_FRAME_SAMPLES: usize = 480;

struct Dictation {
    _capture: audio::Capture,
    task: tokio::task::JoinHandle<()>,
}

enum Session {
    Idle,
    V3(Box<v3::V3Session>),
    Dictation(Dictation),
}

#[tokio::main]
async fn main() -> Result<()> {
    let (events_tx, events_rx) = mpsc::channel::<Event>(EVENT_CHANNEL_CAPACITY);
    let outbox = Arc::new(Outbox::default());
    let router_task = tokio::spawn(route_events(events_rx, Arc::clone(&outbox)));
    let writer_task = tokio::spawn(write_events(outbox, tokio::io::stdout()));
    events_tx
        .send(Event::Ready {
            version: PROTOCOL_VERSION,
            ready_at_ms: unix_millis(),
        })
        .await?;

    let mut session = Session::Idle;
    let mut pcm = Vec::new();
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        let result = async {
            let command = protocol::parse_command(&line).context("invalid voice helper command")?;
            command.validate()?;
            match command {
                Command::ListDevices => {
                    let (inputs, outputs) = audio::devices()?;
                    events_tx.send(Event::Devices { inputs, outputs }).await?;
                }
                Command::StartV3 {
                    microphone,
                    speaker,
                } => {
                    stop(&mut session).await?;
                    events_tx
                        .send(Event::State {
                            state: "connecting",
                        })
                        .await?;
                    let (created, sdp) =
                        v3::V3Session::create_devices(microphone, speaker, events_tx.clone())
                            .await?;
                    session = Session::V3(Box::new(created));
                    events_tx.send(Event::Offer { sdp }).await?;
                }
                Command::StartV3Bridge => {
                    stop(&mut session).await?;
                    events_tx
                        .send(Event::State {
                            state: "connecting",
                        })
                        .await?;
                    let (created, sdp) = v3::V3Session::create_bridge(events_tx.clone()).await?;
                    session = Session::V3(Box::new(created));
                    events_tx.send(Event::Offer { sdp }).await?;
                }
                Command::ApplyAnswer { sdp } => match &session {
                    Session::V3(active) => active.apply_answer(sdp).await?,
                    _ => anyhow::bail!("cannot apply an answer without an active V3 session"),
                },
                Command::SetInputMuted { muted } => match &session {
                    Session::V3(active) => active.set_input_muted(muted).await?,
                    _ => anyhow::bail!("microphone muting requires an active V3 session"),
                },
                Command::SetSpeakerSuppressed { suppressed, epoch } => match &mut session {
                    Session::V3(active) => {
                        active.set_speaker_suppressed(suppressed, epoch)?;
                    }
                    _ => anyhow::bail!("speaker suppression requires an active V3 session"),
                },
                Command::StartDictation { microphone } => {
                    stop(&mut session).await?;
                    let capture = audio::capture(microphone.as_deref())?;
                    let queue = capture.frames.clone();
                    let dropped = capture.dropped.clone();
                    let failed = capture.failed.clone();
                    let source_rate = capture.sample_rate;
                    // A new recording starts before its first PCM frame can be queued.
                    events_tx.send(Event::State { state: "listening" }).await?;
                    let dictation_events = events_tx.clone();
                    let task = tokio::spawn(async move {
                        let mut resampler =
                            match resample::LinearResampler::new(source_rate, 24_000) {
                                Ok(value) => value,
                                Err(error) => {
                                    let _ = dictation_events
                                        .send(Event::Error {
                                            message: error.to_string(),
                                        })
                                        .await;
                                    return;
                                }
                            };
                        let mut source = Vec::new();
                        let mut converted = Vec::new();
                        let mut pending = Vec::new();
                        let mut bytes = Vec::with_capacity(DICTATION_FRAME_SAMPLES * 2);
                        let mut ticker =
                            tokio::time::interval(std::time::Duration::from_millis(20));
                        loop {
                            ticker.tick().await;
                            if failed.load(std::sync::atomic::Ordering::Acquire) {
                                let _ = dictation_events
                                    .send(Event::Error {
                                        message: "microphone stream failed".to_owned(),
                                    })
                                    .await;
                                return;
                            }
                            if dropped.swap(false, std::sync::atomic::Ordering::AcqRel) {
                                audio::clear(&queue);
                                resampler.reset();
                                pending.clear();
                            }
                            source.clear();
                            converted.clear();
                            for _ in 0..queue.capacity() {
                                let Some(frame) = queue.pop() else { break };
                                source.extend_from_slice(&frame.samples[..frame.len]);
                            }
                            resampler.process(&source, &mut converted);
                            pending.extend_from_slice(&converted);
                            while pending.len() >= DICTATION_FRAME_SAMPLES {
                                encode_pcm16(&pending[..DICTATION_FRAME_SAMPLES], &mut bytes);
                                pending.drain(..DICTATION_FRAME_SAMPLES);
                                if dictation_events
                                    .send(Event::Pcm {
                                        audio: BASE64.encode(&bytes),
                                        sample_rate: 24_000,
                                        num_channels: 1,
                                        epoch: None,
                                    })
                                    .await
                                    .is_err()
                                {
                                    return;
                                }
                            }
                        }
                    });
                    session = Session::Dictation(Dictation {
                        _capture: capture,
                        task,
                    });
                }
                Command::SendData { message } => match &session {
                    Session::V3(active) => active.send(message)?,
                    _ => anyhow::bail!("data messages require an active V3 session"),
                },
                Command::SendPcm { audio, .. } => match &session {
                    Session::V3(active) => {
                        pcm.clear();
                        BASE64
                            .decode_vec(audio, &mut pcm)
                            .context("invalid bridge PCM encoding")?;
                        if pcm.len() > protocol::MAX_PCM_BYTES {
                            anyhow::bail!("bridge PCM exceeds {} bytes", protocol::MAX_PCM_BYTES);
                        }
                        active.send_pcm(&pcm)?;
                    }
                    _ => anyhow::bail!("PCM input requires an active V3 session"),
                },
                Command::Stop => {
                    stop(&mut session).await?;
                    events_tx.send(Event::Stopped).await?;
                }
                Command::Shutdown => {
                    stop(&mut session).await?;
                    return Ok(true);
                }
            }
            Result::<bool>::Ok(false)
        }
        .await;
        match result {
            Ok(true) => break,
            Ok(false) => {}
            Err(error) => {
                events_tx
                    .send(Event::Error {
                        message: format!("{error:#}"),
                    })
                    .await?
            }
        }
    }
    stop(&mut session).await?;
    drop(events_tx);
    router_task.await?;
    writer_task.await?;
    Ok(())
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

fn encode_pcm16(samples: &[f32], output: &mut Vec<u8>) {
    output.clear();
    for sample in samples {
        output
            .extend_from_slice(&((sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16).to_le_bytes());
    }
}

/// Stdout queues: control events keep their order and always go first; PCM has
/// its own bounded, age-limited queue so a slow reader drops stale audio
/// instead of delaying a state, data, error, or stop event behind it.
///
/// Realtime PCM (tagged with a playback epoch) is lossy. Dictation PCM (no
/// epoch) is a complete recording: the first lost frame queues one error and
/// fails the recording, and a stop writes the accepted frames before its
/// acknowledgement.
#[derive(Default)]
struct Outbox {
    queues: Mutex<OutboxQueues>,
    queued: Notify,
    space: Notify,
}

impl Outbox {
    fn lock(&self) -> MutexGuard<'_, OutboxQueues> {
        self.queues.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Waits only while the control queue is full; PCM is always accepted.
    async fn push(&self, mut event: Event) -> bool {
        loop {
            let space = self.space.notified();
            {
                let mut queues = self.lock();
                if queues.writer_stopped {
                    return false;
                }
                match queues.offer(event, Instant::now()) {
                    Ok(()) => {
                        drop(queues);
                        self.queued.notify_one();
                        return true;
                    }
                    Err(rejected) => event = rejected,
                }
            }
            space.await;
        }
    }

    fn close(&self) {
        self.lock().closed = true;
        self.queued.notify_one();
    }

    fn stop_writer(&self) {
        self.lock().writer_stopped = true;
        self.space.notify_one();
    }
}

struct QueuedPcm {
    event: Event,
    at: Instant,
    epoch: Option<u64>,
}

enum Control {
    Event(Event),
    /// Dictation PCM accepted before a stop, written ahead of its acknowledgement
    /// unless it expires first.
    Drained(QueuedPcm),
}

#[derive(Default)]
struct OutboxQueues {
    control: VecDeque<Control>,
    media: VecDeque<QueuedPcm>,
    dropped_media: u64,
    dictation_failed: bool,
    closed: bool,
    writer_stopped: bool,
}

enum Outgoing {
    Event(Event),
    Empty,
    Closed,
}

impl OutboxQueues {
    fn offer(&mut self, event: Event, now: Instant) -> std::result::Result<(), Event> {
        match event {
            Event::Pcm { epoch, .. } => {
                self.push_media(event, epoch, now);
                Ok(())
            }
            // Activity is a lossy hint; one pending copy says the same thing.
            Event::PlaybackActivity
                if self
                    .control
                    .iter()
                    .any(|queued| matches!(queued, Control::Event(Event::PlaybackActivity))) =>
            {
                Ok(())
            }
            event if self.control.len() >= CONTROL_EVENT_CAPACITY => Err(event),
            event => {
                match event {
                    // Stop retires realtime frames but completes the dictation recording:
                    // its accepted frames go ahead of the acknowledgement.
                    Event::Stopped => {
                        self.drop_media(|queued| queued.epoch.is_some());
                        self.control
                            .extend(self.media.drain(..).map(Control::Drained));
                    }
                    // A new call retires every queued frame from the previous session.
                    Event::State {
                        state: "connecting",
                    } => self.drop_media(|_| true),
                    Event::State { state: "listening" } => self.dictation_failed = false,
                    _ => {}
                }
                self.control.push_back(Control::Event(event));
                Ok(())
            }
        }
    }

    fn push_media(&mut self, event: Event, epoch: Option<u64>, now: Instant) {
        if let Some(epoch) = epoch {
            // A newer playback epoch retires queued frames from older epochs.
            self.drop_media(|queued| queued.epoch.is_some_and(|queued| queued < epoch));
        }
        let before = self.media.len();
        let mut dictation_lost = false;
        self.media.retain(|queued| {
            let keep = !expired(queued, now);
            dictation_lost |= !keep && queued.epoch.is_none();
            keep
        });
        self.dropped_media += (before - self.media.len()) as u64;
        if dictation_lost {
            self.fail_dictation(false);
        }
        if self.media.len() >= MEDIA_EVENT_CAPACITY
            && let Some(lost) = self.media.pop_front()
        {
            self.lose(&lost, false);
        }
        if epoch.is_none() && self.dictation_failed {
            self.dropped_media += 1;
            return;
        }
        self.media.push_back(QueuedPcm {
            event,
            at: now,
            epoch,
        });
    }

    fn next(&mut self, now: Instant) -> Outgoing {
        loop {
            if let Some(item) = self.control.pop_front() {
                match item {
                    Control::Event(event) => return Outgoing::Event(event),
                    Control::Drained(queued) if !expired(&queued, now) => {
                        return Outgoing::Event(queued.event);
                    }
                    // Only stop's own acknowledgement and later events remain behind it.
                    Control::Drained(queued) => self.lose(&queued, true),
                }
                continue;
            }
            let Some(queued) = self.media.pop_front() else {
                break;
            };
            if !expired(&queued, now) {
                return Outgoing::Event(queued.event);
            }
            self.lose(&queued, false);
        }
        if self.closed {
            Outgoing::Closed
        } else {
            Outgoing::Empty
        }
    }

    fn drop_media(&mut self, retired: impl Fn(&QueuedPcm) -> bool) {
        let before = self.media.len();
        self.media.retain(|queued| !retired(queued));
        self.dropped_media += (before - self.media.len()) as u64;
    }

    /// Counts a frame lost to congestion; losing dictation audio fails the recording.
    fn lose(&mut self, lost: &QueuedPcm, before_stop: bool) {
        self.dropped_media += 1;
        if lost.epoch.is_none() {
            self.fail_dictation(before_stop);
        }
    }

    /// Queues one reliable error for an incomplete recording and drops the rest of
    /// its audio, so the client fails it instead of committing a partial transcript.
    fn fail_dictation(&mut self, before_stop: bool) {
        if self.dictation_failed {
            return;
        }
        self.dictation_failed = true;
        self.drop_media(|queued| queued.epoch.is_none());
        let before = self.control.len();
        self.control
            .retain(|item| !matches!(item, Control::Drained(_)));
        self.dropped_media += (before - self.control.len()) as u64;
        let error = Control::Event(Event::Error {
            message: DICTATION_AUDIO_LOST.to_owned(),
        });
        if before_stop {
            self.control.push_front(error);
        } else {
            self.control.push_back(error);
        }
    }
}

fn expired(queued: &QueuedPcm, now: Instant) -> bool {
    let max_age = if queued.epoch.is_some() {
        REALTIME_PCM_MAX_AGE
    } else {
        DICTATION_PCM_MAX_AGE
    };
    now.saturating_duration_since(queued.at) > max_age
}

async fn route_events(mut events: mpsc::Receiver<Event>, outbox: Arc<Outbox>) {
    while let Some(event) = events.recv().await {
        if !outbox.push(event).await {
            // Stdout is gone: dropping the receiver fails later sends, as before.
            return;
        }
    }
    outbox.close();
}

async fn write_events<W: AsyncWrite + Unpin>(outbox: Arc<Outbox>, mut output: W) {
    let mut line = Vec::new();
    loop {
        let queued = outbox.queued.notified();
        let next = outbox.lock().next(Instant::now());
        let event = match next {
            Outgoing::Event(event) => event,
            Outgoing::Empty => {
                queued.await;
                continue;
            }
            Outgoing::Closed => break,
        };
        outbox.space.notify_one();
        line.clear();
        if let Err(error) = serde_json::to_writer(&mut line, &event) {
            eprintln!("voice event encoding failed: {error}");
            break;
        }
        line.push(b'\n');
        if output.write_all(&line).await.is_err() || output.flush().await.is_err() {
            break;
        }
    }
    outbox.stop_writer();
}

async fn stop(session: &mut Session) -> Result<()> {
    let previous = std::mem::replace(session, Session::Idle);
    match previous {
        Session::Idle => {}
        Session::V3(active) => active.close().await?,
        Session::Dictation(active) => {
            active.task.abort();
            let _ = active.task.await;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use tokio::io::AsyncReadExt;

    use super::*;

    fn pcm(index: usize, epoch: Option<u64>) -> Event {
        Event::Pcm {
            audio: format!("{index:04}{}", "A".repeat(1_336)),
            sample_rate: 24_000,
            num_channels: 1,
            epoch,
        }
    }

    fn pcm_index(event: &Event) -> Option<usize> {
        match event {
            Event::Pcm { audio, .. } => audio[..4].parse().ok(),
            _ => None,
        }
    }

    fn drain_now(queues: &mut OutboxQueues, now: Instant) -> Vec<Event> {
        let mut events = Vec::new();
        while let Outgoing::Event(event) = queues.next(now) {
            events.push(event);
        }
        events
    }

    #[tokio::test]
    async fn stalled_stdout_keeps_control_deliverable_and_drops_oldest_pcm() {
        let (events_tx, events_rx) = mpsc::channel::<Event>(EVENT_CHANNEL_CAPACITY);
        let outbox = Arc::new(Outbox::default());
        let router = tokio::spawn(route_events(events_rx, Arc::clone(&outbox)));
        // A 4 KiB pipe that nobody reads: the writer blocks after about three PCM lines.
        let (writer_end, mut reader_end) = tokio::io::duplex(4 * 1024);
        let writer = tokio::spawn(write_events(Arc::clone(&outbox), writer_end));

        let started = Instant::now();
        for index in 0..1_000 {
            tokio::time::timeout(
                Duration::from_millis(50),
                events_tx.send(pcm(index, Some(1))),
            )
            .await
            .expect("a stalled reader must not block PCM producers")
            .unwrap();
        }
        let produced = started.elapsed();
        tokio::time::timeout(
            Duration::from_millis(50),
            events_tx.send(Event::State {
                state: "suppressed",
            }),
        )
        .await
        .expect("control is accepted while PCM is backed up")
        .unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
        let (queued_media, dropped_media) = {
            let queues = outbox.lock();
            (queues.media.len(), queues.dropped_media)
        };

        // Resume reading: the control event is the next complete line after the
        // frames already in flight, ahead of every still-queued frame.
        let resumed = Instant::now();
        let mut buffer = Vec::new();
        let mut lines = Vec::new();
        while !lines
            .iter()
            .any(|line: &serde_json::Value| line["type"] == "state")
        {
            let mut chunk = [0_u8; 4096];
            let read = tokio::time::timeout(Duration::from_secs(1), reader_end.read(&mut chunk))
                .await
                .expect("control event was not delivered")
                .unwrap();
            buffer.extend_from_slice(&chunk[..read]);
            while let Some(end) = buffer.iter().position(|byte| *byte == b'\n') {
                lines.push(serde_json::from_slice(&buffer[..end]).unwrap());
                buffer.drain(..=end);
            }
        }
        let control_latency = resumed.elapsed();
        let control_position = lines
            .iter()
            .position(|line| line["type"] == "state")
            .unwrap_or(lines.len());
        eprintln!(
            "stalled stdout: 1000 PCM produced in {produced:?}; {queued_media} queued, {dropped_media} dropped; \
             control delivered as line {control_position} in {control_latency:?} after reading resumed"
        );
        assert!(
            control_position <= 4,
            "control waited behind {control_position} lines"
        );
        assert!(queued_media <= MEDIA_EVENT_CAPACITY);
        assert!(dropped_media >= 1_000 - MEDIA_EVENT_CAPACITY as u64 - 4);

        drop(events_tx);
        let mut rest = buffer;
        reader_end.read_to_end(&mut rest).await.unwrap();
        router.await.unwrap();
        writer.await.unwrap();
        let delivered: Vec<usize> = lines
            .iter()
            .chain(
                rest.split(|byte| *byte == b'\n')
                    .filter(|line| !line.is_empty())
                    .map(|line| serde_json::from_slice(line).unwrap())
                    .collect::<Vec<serde_json::Value>>()
                    .iter(),
            )
            .filter_map(|line| line["audio"].as_str()?[..4].parse().ok())
            .collect();
        // Frames stay in order, and the survivors are the newest ones.
        assert!(delivered.windows(2).all(|pair| pair[0] < pair[1]));
        assert_eq!(delivered.last(), Some(&999));
        assert!(delivered.len() <= MEDIA_EVENT_CAPACITY + 4);
    }

    #[tokio::test]
    async fn playout_stats_overtake_stalled_pcm_and_precede_stop() {
        // The speaker probe's diagnostic event is ordered control: it overtakes
        // queued realtime PCM, is neither coalesced nor retired by stop, and
        // keeps the exact field set the TypeScript validator accepts.
        let probe = playout::PlayoutProbe::new();
        let begun = Instant::now();
        probe.begin(4, begun);
        assert!(probe.mark(
            playout::PlayoutMark::Rtp,
            4,
            begun + Duration::from_millis(5)
        ));
        assert!(probe.mark(
            playout::PlayoutMark::Output,
            4,
            begun + Duration::from_millis(60)
        ));
        probe.underrun();
        let (events_tx, events_rx) = mpsc::channel::<Event>(EVENT_CHANNEL_CAPACITY);
        let outbox = Arc::new(Outbox::default());
        let router = tokio::spawn(route_events(events_rx, Arc::clone(&outbox)));
        let (writer_end, mut reader_end) = tokio::io::duplex(4 * 1024);
        let writer = tokio::spawn(write_events(Arc::clone(&outbox), writer_end));
        for index in 0..200 {
            events_tx.send(pcm(index, Some(4))).await.unwrap();
        }
        events_tx.send(probe.stats(4, 80)).await.unwrap();
        events_tx.send(Event::PlaybackActivity).await.unwrap();
        events_tx.send(probe.stats(4, 80)).await.unwrap();
        events_tx.send(Event::Stopped).await.unwrap();
        drop(events_tx);
        // Let the router queue everything behind the stalled pipe before reading.
        tokio::time::sleep(Duration::from_millis(20)).await;
        let mut output = Vec::new();
        reader_end.read_to_end(&mut output).await.unwrap();
        router.await.unwrap();
        writer.await.unwrap();
        let lines: Vec<serde_json::Value> = output
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).unwrap())
            .collect();
        let types: Vec<&str> = lines
            .iter()
            .map(|line| line["type"].as_str().unwrap())
            .collect();
        let first_stats = types
            .iter()
            .position(|kind| *kind == "playout_stats")
            .expect("playout stats were dropped");
        assert!(
            first_stats <= 4,
            "playout stats waited behind {first_stats} lines"
        );
        assert!(types[..first_stats].iter().all(|kind| *kind == "pcm"));
        assert_eq!(
            types[first_stats..],
            [
                "playout_stats",
                "playback_activity",
                "playout_stats",
                "stopped"
            ]
        );
        let stats = lines[first_stats].as_object().unwrap();
        let mut keys: Vec<&str> = stats.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "epoch",
                "first_output_us",
                "first_rtp_us",
                "start_threshold_ms",
                "type",
                "underruns"
            ]
        );
        assert_eq!(stats["epoch"], 4);
        assert_eq!(stats["first_rtp_us"], 5_000);
        assert_eq!(stats["first_output_us"], 60_000);
        assert_eq!(stats["underruns"], 1);
        assert_eq!(stats["start_threshold_ms"], 80);
    }

    #[tokio::test]
    async fn stop_is_delivered_promptly_and_retires_queued_pcm() {
        let (events_tx, events_rx) = mpsc::channel::<Event>(EVENT_CHANNEL_CAPACITY);
        let outbox = Arc::new(Outbox::default());
        let router = tokio::spawn(route_events(events_rx, Arc::clone(&outbox)));
        let (writer_end, mut reader_end) = tokio::io::duplex(4 * 1024);
        let writer = tokio::spawn(write_events(Arc::clone(&outbox), writer_end));
        for index in 0..200 {
            events_tx.send(pcm(index, Some(3))).await.unwrap();
        }
        events_tx.send(Event::Stopped).await.unwrap();
        drop(events_tx);
        let mut output = Vec::new();
        reader_end.read_to_end(&mut output).await.unwrap();
        router.await.unwrap();
        writer.await.unwrap();
        let lines: Vec<serde_json::Value> = output
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).unwrap())
            .collect();
        assert_eq!(lines.last().unwrap()["type"], "stopped");
        assert!(
            lines.len() <= 5,
            "stop waited behind {} lines",
            lines.len() - 1
        );
    }

    #[test]
    fn realtime_pcm_is_age_limited_and_epoch_aware() {
        let start = Instant::now();
        let mut queues = OutboxQueues::default();
        queues.offer(pcm(0, Some(1)), start).unwrap();
        queues
            .offer(pcm(1, Some(1)), start + Duration::from_millis(100))
            .unwrap();
        queues
            .offer(Event::State { state: "ready" }, start)
            .unwrap();
        let events = drain_now(&mut queues, start + Duration::from_millis(250));
        assert!(matches!(events[0], Event::State { state: "ready" }));
        assert_eq!(
            events[1..].iter().filter_map(pcm_index).collect::<Vec<_>>(),
            [1]
        );

        queues.offer(pcm(2, Some(1)), start).unwrap();
        queues.offer(pcm(3, Some(2)), start).unwrap();
        queues.offer(pcm(4, Some(2)), start).unwrap();
        let events = drain_now(&mut queues, start);
        assert_eq!(
            events.iter().filter_map(pcm_index).collect::<Vec<_>>(),
            [3, 4]
        );
    }

    #[test]
    fn dictation_pcm_survives_a_longer_reader_stall() {
        let start = Instant::now();
        let mut queues = OutboxQueues::default();
        for index in 0..50 {
            queues
                .offer(
                    pcm(index, None),
                    start + Duration::from_millis(20 * index as u64),
                )
                .unwrap();
        }
        let events = drain_now(&mut queues, start + Duration::from_millis(1_500));
        assert_eq!(events.len(), 50);
    }

    #[test]
    fn media_capacity_drops_oldest_and_control_keeps_order() {
        let start = Instant::now();
        let mut queues = OutboxQueues::default();
        for index in 0..MEDIA_EVENT_CAPACITY + 10 {
            queues.offer(pcm(index, Some(1)), start).unwrap();
        }
        queues.offer(Event::PlaybackActivity, start).unwrap();
        queues
            .offer(Event::State { state: "connected" }, start)
            .unwrap();
        queues.offer(Event::PlaybackActivity, start).unwrap();
        queues.offer(Event::Stopped, start).unwrap();
        let events = drain_now(&mut queues, start);
        assert!(matches!(events[0], Event::PlaybackActivity));
        assert!(matches!(events[1], Event::State { state: "connected" }));
        assert!(matches!(events[2], Event::Stopped));
        assert_eq!(
            events.len(),
            3,
            "stop retires frames from the stopped session"
        );

        for index in 0..MEDIA_EVENT_CAPACITY + 10 {
            queues.offer(pcm(index, Some(1)), start).unwrap();
        }
        let indexes: Vec<_> = drain_now(&mut queues, start)
            .iter()
            .filter_map(pcm_index)
            .collect();
        assert_eq!(indexes.len(), MEDIA_EVENT_CAPACITY);
        assert_eq!(indexes[0], 10);

        for _ in 0..CONTROL_EVENT_CAPACITY {
            queues.offer(Event::Stopped, start).unwrap();
        }
        assert!(queues.offer(Event::Stopped, start).is_err());
        assert!(queues.offer(pcm(0, None), start).is_ok());
    }

    struct Pipeline {
        events: mpsc::Sender<Event>,
        reader: tokio::io::DuplexStream,
        router: tokio::task::JoinHandle<()>,
        writer: tokio::task::JoinHandle<()>,
    }

    /// The real router and writer over a 4 KiB pipe that is not read until
    /// `finish`, so the writer blocks after about three PCM lines.
    fn stalled_pipeline() -> Pipeline {
        let (events, events_rx) = mpsc::channel::<Event>(EVENT_CHANNEL_CAPACITY);
        let outbox = Arc::new(Outbox::default());
        let router = tokio::spawn(route_events(events_rx, Arc::clone(&outbox)));
        let (writer_end, reader) = tokio::io::duplex(4 * 1024);
        let writer = tokio::spawn(write_events(outbox, writer_end));
        Pipeline {
            events,
            reader,
            router,
            writer,
        }
    }

    impl Pipeline {
        async fn finish(self) -> Vec<serde_json::Value> {
            let Pipeline {
                events,
                mut reader,
                router,
                writer,
            } = self;
            drop(events);
            let mut output = Vec::new();
            reader.read_to_end(&mut output).await.unwrap();
            router.await.unwrap();
            writer.await.unwrap();
            output
                .split(|byte| *byte == b'\n')
                .filter(|line| !line.is_empty())
                .map(|line| serde_json::from_slice(line).unwrap())
                .collect()
        }
    }

    fn line_types(lines: &[serde_json::Value]) -> Vec<&str> {
        lines
            .iter()
            .map(|line| line["type"].as_str().unwrap())
            .collect()
    }

    fn line_index(line: &serde_json::Value) -> Option<usize> {
        line["audio"].as_str()?[..4].parse().ok()
    }

    #[tokio::test]
    async fn stop_writes_accepted_dictation_pcm_before_its_acknowledgement() {
        let pipeline = stalled_pipeline();
        for index in 0..100 {
            pipeline.events.send(pcm(index, None)).await.unwrap();
        }
        pipeline.events.send(Event::Stopped).await.unwrap();
        let lines = pipeline.finish().await;
        assert_eq!(lines.last().unwrap()["type"], "stopped");
        assert!(!line_types(&lines).contains(&"error"));
        let delivered: Vec<_> = lines.iter().filter_map(line_index).collect();
        assert_eq!(delivered, (0..100).collect::<Vec<_>>());
    }

    #[tokio::test]
    async fn stalled_stop_drain_reports_lost_dictation_before_its_acknowledgement() {
        let pipeline = stalled_pipeline();
        for index in 0..20 {
            pipeline.events.send(pcm(index, None)).await.unwrap();
        }
        pipeline.events.send(Event::Stopped).await.unwrap();
        // The reader stays stalled past the dictation age limit.
        tokio::time::sleep(DICTATION_PCM_MAX_AGE + Duration::from_millis(200)).await;
        let lines = pipeline.finish().await;
        let types = line_types(&lines);
        eprintln!("stalled stop drain: {types:?}");
        assert_eq!(types[types.len() - 2..], ["error", "stopped"]);
        assert_eq!(lines[lines.len() - 2]["message"], DICTATION_AUDIO_LOST);
        assert_eq!(types.iter().filter(|kind| **kind == "error").count(), 1);
        assert!(lines.iter().filter_map(line_index).count() < 20);
    }

    #[tokio::test]
    async fn dictation_capacity_loss_fails_the_recording_once() {
        let pipeline = stalled_pipeline();
        for index in 0..MEDIA_EVENT_CAPACITY + 20 {
            pipeline.events.send(pcm(index, None)).await.unwrap();
        }
        pipeline.events.send(Event::Stopped).await.unwrap();
        let lines = pipeline.finish().await;
        let types = line_types(&lines);
        let error = types.iter().position(|kind| *kind == "error").unwrap();
        assert_eq!(lines[error]["message"], DICTATION_AUDIO_LOST);
        assert_eq!(types.iter().filter(|kind| **kind == "error").count(), 1);
        // Only frames already in the pipe precede the error; none follow it.
        assert!(error <= 4, "error waited behind {error} lines");
        assert_eq!(types[error + 1..], ["stopped"]);
    }

    #[tokio::test]
    async fn dictation_expiry_fails_the_recording_once() {
        let pipeline = stalled_pipeline();
        for index in 0..20 {
            pipeline.events.send(pcm(index, None)).await.unwrap();
        }
        tokio::time::sleep(DICTATION_PCM_MAX_AGE + Duration::from_millis(200)).await;
        // Frames from the failed recording are not written after the error.
        pipeline.events.send(pcm(20, None)).await.unwrap();
        pipeline.events.send(Event::Stopped).await.unwrap();
        let lines = pipeline.finish().await;
        let types = line_types(&lines);
        eprintln!("dictation expiry: {types:?}");
        let error = types.iter().position(|kind| *kind == "error").unwrap();
        assert_eq!(lines[error]["message"], DICTATION_AUDIO_LOST);
        assert_eq!(types.iter().filter(|kind| **kind == "error").count(), 1);
        assert_eq!(types[error + 1..], ["stopped"]);
    }

    #[test]
    fn a_new_recording_clears_the_dictation_failure() {
        let start = Instant::now();
        let mut queues = OutboxQueues::default();
        for index in 0..MEDIA_EVENT_CAPACITY + 1 {
            queues.offer(pcm(index, None), start).unwrap();
        }
        assert!(queues.dictation_failed);
        queues.offer(Event::Stopped, start).unwrap();
        queues
            .offer(Event::State { state: "listening" }, start)
            .unwrap();
        queues.offer(pcm(0, None), start).unwrap();
        let events = drain_now(&mut queues, start);
        assert!(matches!(events[0], Event::Error { .. }));
        assert!(matches!(events[1], Event::Stopped));
        assert!(matches!(events[2], Event::State { state: "listening" }));
        assert_eq!(pcm_index(&events[3]), Some(0));
        assert_eq!(events.len(), 4);
    }

    #[test]
    fn scratch_reuse_yields_identical_bytes() {
        let frames: Vec<Vec<f32>> = (0..4)
            .map(|frame| {
                (0..DICTATION_FRAME_SAMPLES)
                    .map(|index| ((index + frame * 7) as f32 / 97.0).sin() * 1.2)
                    .collect()
            })
            .collect();
        let mut scratch = Vec::new();
        let mut decoded = Vec::new();
        for frame in &frames {
            let mut fresh = Vec::with_capacity(960);
            for sample in frame.clone() {
                fresh.extend_from_slice(
                    &((sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16).to_le_bytes(),
                );
            }
            encode_pcm16(frame, &mut scratch);
            assert_eq!(scratch, fresh);

            let audio = BASE64.encode(&fresh);
            decoded.clear();
            BASE64.decode_vec(&audio, &mut decoded).unwrap();
            assert_eq!(decoded, BASE64.decode(&audio).unwrap());
        }
    }
}

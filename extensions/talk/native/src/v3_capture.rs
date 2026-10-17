use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use bytes::Bytes;
use crossbeam_queue::ArrayQueue;
use tokio::sync::{mpsc, oneshot};
use webrtc::media::Sample as MediaSample;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;

use super::{
    BRIDGE_RATE, OPUS_FRAME_SAMPLES, OPUS_RATE, report_terminal_error, with_send_deadline,
};
use crate::audio::{self, SpeakerState};
use crate::codex_audio::buffers::Frame;
use crate::codex_audio::processing::{self, EncodedAudio, Processor};
use crate::protocol::Event;
use crate::resample::LinearResampler;

/// Bridge input older than this is stale: it is trimmed instead of being sent late.
pub(crate) const BRIDGE_JITTER_WINDOW: Duration = Duration::from_millis(120);
/// After the window is exceeded, whole blocks are trimmed down to this age so a
/// recovered queue does not keep running at the edge of the window.
pub(crate) const BRIDGE_TRIM_TARGET: Duration = Duration::from_millis(40);
/// Storage bound for queued bridge samples, independent of the age policy.
const BRIDGE_STORAGE_SAMPLES: usize = BRIDGE_RATE as usize * 3;
const BRIDGE_TICK_SAMPLES: usize = BRIDGE_RATE as usize / 50;

struct InputTransition {
    generation: u64,
    done: oneshot::Sender<()>,
}

pub(crate) struct InputControl {
    generation: Arc<AtomicU64>,
    transitions: mpsc::Sender<InputTransition>,
    bridge: Option<Arc<Mutex<BridgeQueue>>>,
}

/// Up to one tick of a `send_pcm` payload, stamped on arrival. `due` is when
/// its first unsent sample should have been sent if it had been drained at real
/// time.
struct BridgeBlock {
    samples: Vec<f32>,
    consumed: usize,
    due: Instant,
    generation: u64,
}

impl BridgeBlock {
    fn remaining(&self) -> usize {
        self.samples.len() - self.consumed
    }
}

/// Timestamped bridge input blocks. The encoder drains at most one 20 ms frame
/// per tick, so backlog is trimmed by age instead of being sent faster than
/// real time.
#[derive(Default)]
pub(crate) struct BridgeQueue {
    blocks: VecDeque<BridgeBlock>,
    queued: usize,
}

impl BridgeQueue {
    /// Payloads longer than one tick are split into tick-sized blocks, so the
    /// age policy can trim an oversized payload whole block by whole block
    /// instead of draining it above the jitter window.
    pub(crate) fn push(&mut self, samples: Vec<f32>, generation: u64, now: Instant) {
        if samples.len() <= BRIDGE_TICK_SAMPLES {
            self.push_block(samples, generation, now);
            return;
        }
        for (index, chunk) in samples.chunks(BRIDGE_TICK_SAMPLES).enumerate() {
            let due = now + samples_duration(index * BRIDGE_TICK_SAMPLES);
            self.push_block(chunk.to_vec(), generation, due);
        }
    }

    fn push_block(&mut self, samples: Vec<f32>, generation: u64, due: Instant) {
        if samples.is_empty() {
            return;
        }
        while self.queued + samples.len() > BRIDGE_STORAGE_SAMPLES {
            self.pop_front();
        }
        self.queued += samples.len();
        self.blocks.push_back(BridgeBlock {
            samples,
            consumed: 0,
            due,
            generation,
        });
    }

    /// The delay the newest queued sample will see, or how late the oldest
    /// unsent sample already is, whichever is larger.
    pub(crate) fn age(&self, now: Instant) -> Duration {
        let waited = self.blocks.front().map_or(Duration::ZERO, |block| {
            now.saturating_duration_since(block.due)
        });
        samples_duration(self.queued).max(waited)
    }

    #[cfg(test)]
    pub(crate) fn queued_samples(&self) -> usize {
        self.queued
    }

    /// Drop whole stale blocks once the queue age exceeds the jitter window.
    /// Returns the number of unsent samples dropped.
    pub(crate) fn trim(&mut self, now: Instant) -> usize {
        if self.age(now) <= BRIDGE_JITTER_WINDOW {
            return 0;
        }
        let before = self.queued;
        while self.blocks.len() > 1 && self.age(now) > BRIDGE_TRIM_TARGET {
            self.pop_front();
        }
        if self
            .blocks
            .front()
            .is_some_and(|block| now.saturating_duration_since(block.due) > BRIDGE_JITTER_WINDOW)
        {
            self.pop_front();
        }
        before - self.queued
    }

    /// Append at most `limit` current-generation samples to `output`.
    pub(crate) fn drain(
        &mut self,
        generation: u64,
        limit: usize,
        now: Instant,
        output: &mut Vec<f32>,
    ) {
        while self
            .blocks
            .front()
            .is_some_and(|block| block.generation != generation)
        {
            self.pop_front();
        }
        self.trim(now);
        let mut wanted = limit;
        while wanted > 0 {
            let Some(block) = self.blocks.front_mut() else {
                break;
            };
            if block.generation != generation {
                self.pop_front();
                continue;
            }
            let count = block.remaining().min(wanted);
            output.extend_from_slice(&block.samples[block.consumed..block.consumed + count]);
            block.consumed += count;
            block.due += samples_duration(count);
            self.queued -= count;
            wanted -= count;
            if block.remaining() == 0 {
                self.blocks.pop_front();
            }
        }
    }

    pub(crate) fn clear(&mut self) {
        self.blocks.clear();
        self.queued = 0;
    }

    fn pop_front(&mut self) {
        if let Some(block) = self.blocks.pop_front() {
            self.queued -= block.remaining();
        }
    }
}

fn samples_duration(samples: usize) -> Duration {
    Duration::from_micros(samples as u64 * 1_000_000 / BRIDGE_RATE as u64)
}

pub(crate) fn decode_pcm16(pcm: &[u8]) -> Vec<f32> {
    pcm.as_chunks::<2>()
        .0
        .iter()
        .map(|bytes| {
            let sample = i16::from_le_bytes(*bytes);
            sample as f32 / if sample < 0 { 32_768.0 } else { 32_767.0 }
        })
        .collect()
}

fn lock_bridge(queue: &Mutex<BridgeQueue>) -> std::sync::MutexGuard<'_, BridgeQueue> {
    queue.lock().unwrap_or_else(PoisonError::into_inner)
}

pub(crate) struct DeviceEncoder {
    pub(crate) frames: Arc<ArrayQueue<Frame>>,
    pub(crate) input_rate: u32,
    pub(crate) generation: Arc<AtomicU64>,
    pub(crate) dropped: Arc<AtomicBool>,
    pub(crate) failed: Arc<AtomicBool>,
    pub(crate) rendered: Arc<ArrayQueue<Frame>>,
    pub(crate) output_rate: u32,
    pub(crate) render_dropped: Arc<AtomicBool>,
    pub(crate) speaker: Arc<SpeakerState>,
}

impl InputControl {
    pub(crate) async fn set_muted(&self, muted: bool) -> Result<()> {
        let current = self.generation.load(Ordering::Acquire);
        if (current % 2 == 1) == muted {
            return Ok(());
        }
        let next = current
            .checked_add(1)
            .context("microphone generation exhausted")?;
        self.generation.store(next, Ordering::Release);
        let (done, completed) = oneshot::channel();
        self.transitions
            .send(InputTransition {
                generation: next,
                done,
            })
            .await
            .context("realtime microphone worker stopped")?;
        completed
            .await
            .context("realtime microphone transition was not applied")
    }

    pub(crate) fn push_bridge_pcm(&self, pcm: &[u8]) -> Result<()> {
        let bridge = self
            .bridge
            .as_ref()
            .context("PCM input requires a bridge V3 session")?;
        if !pcm.len().is_multiple_of(2) {
            anyhow::bail!("bridge PCM must contain complete i16 samples");
        }
        let generation = self.generation.load(Ordering::Acquire);
        if generation % 2 == 1 {
            return Ok(());
        }
        let samples = decode_pcm16(pcm);
        lock_bridge(bridge).push(samples, generation, Instant::now());
        Ok(())
    }
}

pub(crate) fn spawn_device_encoder(
    track: Arc<TrackLocalStaticSample>,
    device: DeviceEncoder,
    enabled: Arc<AtomicBool>,
    events: mpsc::Sender<Event>,
) -> (InputControl, tokio::task::JoinHandle<()>) {
    let DeviceEncoder {
        frames,
        input_rate,
        generation,
        dropped,
        failed,
        rendered,
        output_rate,
        render_dropped,
        speaker,
    } = device;
    let (transitions, mut transition_rx) = mpsc::channel::<InputTransition>(4);
    let input = InputControl {
        generation: Arc::clone(&generation),
        transitions,
        bridge: None,
    };
    let task = tokio::spawn(async move {
        let mut processor = match Processor::new(input_rate, output_rate) {
            Ok(processor) => processor,
            Err(error) => {
                report_terminal_error(&events, error).await;
                return;
            }
        };
        let mut pending = VecDeque::<(u64, EncodedAudio)>::new();
        let mut ticker = tokio::time::interval(Duration::from_millis(20));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut was_enabled = false;
        let mut speaker_epoch = speaker.get().epoch;
        loop {
            tokio::select! {
                biased;
                Some(transition) = transition_rx.recv() => {
                    if transition.generation != generation.load(Ordering::Acquire) {
                        report_terminal_error(&events, "microphone transition generation mismatch").await;
                        return;
                    }
                    audio::clear(&frames);
                    pending.clear();
                    if let Err(error) = processor.reset() {
                        report_terminal_error(&events, error).await;
                        return;
                    }
                    let _ = transition.done.send(());
                }
                _ = ticker.tick() => {
                    if failed.load(Ordering::Acquire) {
                        report_terminal_error(&events, "microphone stream failed").await;
                        return;
                    }
                    let active_speaker = speaker.get();
                    if active_speaker.epoch != speaker_epoch {
                        speaker_epoch = active_speaker.epoch;
                        processor.reset_render();
                        audio::clear(&rendered);
                    }
                    if render_dropped.swap(false, Ordering::AcqRel) {
                        processor.reset_render();
                        audio::clear(&rendered);
                    }
                    for _ in 0..rendered.capacity() {
                        let Some(frame) = rendered.pop() else {
                            break;
                        };
                        if frame.generation == speaker_epoch
                            && processor.render(&frame).is_err()
                        {
                            report_terminal_error(&events, "voice echo reference failed").await;
                            return;
                        }
                    }
                    let is_enabled = enabled.load(Ordering::Acquire);
                    if !is_enabled {
                        audio::clear(&frames);
                        pending.clear();
                        if was_enabled && processor.reset().is_err() {
                            report_terminal_error(&events, "failed to reset voice processing").await;
                            return;
                        }
                        was_enabled = false;
                        continue;
                    }
                    was_enabled = true;
                    let current = generation.load(Ordering::Acquire);
                    if current % 2 == 1 {
                        audio::clear(&frames);
                        pending.clear();
                        let silence = match processor.silence(Instant::now()) {
                            Ok(silence) => silence,
                            Err(error) => {
                                report_terminal_error(&events, error).await;
                                return;
                            }
                        };
                        if write_encoded(&track, silence, &events).await.is_err() {
                            return;
                        }
                        continue;
                    }
                    if dropped.swap(false, Ordering::AcqRel) {
                        audio::clear(&frames);
                        pending.clear();
                        if let Err(error) = processor.reset() {
                            report_terminal_error(&events, error).await;
                            return;
                        }
                    }
                    if pending.is_empty() {
                        for _ in 0..frames.capacity() {
                            let Some(frame) = frames.pop() else {
                                break;
                            };
                            if frame.generation != current {
                                continue;
                            }
                            match processor.capture(&frame, Instant::now) {
                                Ok(encoded) => {
                                    pending.extend(encoded.into_iter().map(|audio| (current, audio)));
                                }
                                Err(processing::PROCESSING_LATE) => {
                                    pending.clear();
                                    if let Err(error) = processor.reset() {
                                        report_terminal_error(&events, error).await;
                                        return;
                                    }
                                }
                                Err(error) => {
                                    report_terminal_error(&events, error).await;
                                    return;
                                }
                            }
                        }
                    }
                    let Some((packet_generation, packet)) = pending.pop_front() else {
                        continue;
                    };
                    if packet_generation != generation.load(Ordering::Acquire) {
                        pending.clear();
                        continue;
                    }
                    if Instant::now().saturating_duration_since(packet.at)
                        > processing::MAX_PROCESSING_DELAY
                    {
                        pending.clear();
                        if let Err(error) = processor.reset() {
                            report_terminal_error(&events, error).await;
                            return;
                        }
                        continue;
                    }
                    if write_encoded(&track, packet, &events).await.is_err() {
                        return;
                    }
                }
            }
        }
    });
    (input, task)
}

pub(crate) fn spawn_bridge_encoder(
    track: Arc<TrackLocalStaticSample>,
    enabled: Arc<AtomicBool>,
    events: mpsc::Sender<Event>,
) -> (InputControl, tokio::task::JoinHandle<()>) {
    let generation = Arc::new(AtomicU64::new(0));
    let samples = Arc::new(Mutex::new(BridgeQueue::default()));
    let (transitions, mut transition_rx) = mpsc::channel::<InputTransition>(4);
    let input = InputControl {
        generation: Arc::clone(&generation),
        transitions,
        bridge: Some(Arc::clone(&samples)),
    };
    let task = tokio::spawn(async move {
        let mut encoder = match new_opus_encoder() {
            Ok(encoder) => encoder,
            Err(error) => {
                report_terminal_error(&events, &error.to_string()).await;
                return;
            }
        };
        let mut resampler = match LinearResampler::new(BRIDGE_RATE, OPUS_RATE) {
            Ok(resampler) => resampler,
            Err(error) => {
                report_terminal_error(&events, &error.to_string()).await;
                return;
            }
        };
        let mut pending = Vec::new();
        let mut source = Vec::new();
        let mut packet = vec![0_u8; 4_000];
        let mut ticker = tokio::time::interval(Duration::from_millis(20));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                biased;
                Some(transition) = transition_rx.recv() => {
                    if transition.generation != generation.load(Ordering::Acquire) {
                        report_terminal_error(&events, "microphone transition generation mismatch").await;
                        return;
                    }
                    lock_bridge(&samples).clear();
                    pending.clear();
                    resampler.reset();
                    match new_opus_encoder() {
                        Ok(replacement) => encoder = replacement,
                        Err(error) => {
                            report_terminal_error(&events, &error.to_string()).await;
                            return;
                        }
                    }
                    let _ = transition.done.send(());
                }
                _ = ticker.tick() => {
                    if !enabled.load(Ordering::Acquire) {
                        lock_bridge(&samples).clear();
                        pending.clear();
                        resampler.reset();
                        continue;
                    }
                    let current = generation.load(Ordering::Acquire);
                    source.clear();
                    lock_bridge(&samples).drain(
                        current,
                        BRIDGE_TICK_SAMPLES,
                        Instant::now(),
                        &mut source,
                    );
                    if current % 2 == 1 {
                        pending.clear();
                        pending.resize(OPUS_FRAME_SAMPLES, 0.0);
                    } else {
                        resampler.process(&source, &mut pending);
                    }
                    while pending.len() >= OPUS_FRAME_SAMPLES {
                        if current != generation.load(Ordering::Acquire) {
                            pending.clear();
                            break;
                        }
                        let encoded = encoder.encode_float(&pending[..OPUS_FRAME_SAMPLES], &mut packet);
                        pending.drain(..OPUS_FRAME_SAMPLES);
                        let size = match encoded {
                            Ok(size) => size,
                            Err(error) => {
                                report_terminal_error(
                                    &events,
                                    &format!("realtime microphone encoder failed: {error}"),
                                ).await;
                                return;
                            }
                        };
                        let encoded = EncodedAudio {
                            data: packet[..size].to_vec(),
                            at: Instant::now(),
                        };
                        if write_encoded(&track, encoded, &events).await.is_err() {
                            return;
                        }
                    }
                }
            }
        }
    });
    (input, task)
}

fn new_opus_encoder() -> Result<opus::Encoder> {
    opus::Encoder::new(OPUS_RATE, opus::Channels::Mono, opus::Application::Voip)
        .context("could not start realtime audio encoder")
}

async fn write_encoded(
    track: &TrackLocalStaticSample,
    packet: EncodedAudio,
    events: &mpsc::Sender<Event>,
) -> Result<()> {
    let sample = MediaSample {
        data: Bytes::from(packet.data),
        duration: Duration::from_millis(20),
        ..Default::default()
    };
    let send = track.write_sample(&sample);
    let failure = match with_send_deadline(send).await {
        Ok(Ok(())) => return Ok(()),
        Ok(Err(error)) => format!("realtime microphone stream failed: {error}"),
        Err(_) => "realtime microphone stream stalled".to_owned(),
    };
    report_terminal_error(events, &failure).await;
    anyhow::bail!(failure)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BLOCK: usize = BRIDGE_TICK_SAMPLES;
    const TICK: Duration = Duration::from_millis(20);

    fn block(value: f32) -> Vec<f32> {
        vec![value; BLOCK]
    }

    #[test]
    fn burst_then_nominal_input_recovers_to_low_age_within_the_window() {
        let start = Instant::now();
        let mut queue = BridgeQueue::default();
        let mut output = Vec::new();
        // A 500 ms stall releases 25 blocks at once; nominal 20 ms blocks follow.
        for index in 0..25 {
            queue.push(block(index as f32), 0, start);
        }
        assert_eq!(queue.age(start), Duration::from_millis(500));
        let mut ages = Vec::new();
        for tick in 0..50_u32 {
            let now = start + TICK * tick;
            queue.push(block(100.0 + tick as f32), 0, now);
            output.clear();
            queue.drain(0, BLOCK, now, &mut output);
            assert!(
                output.len() <= BLOCK,
                "backlog is never sent faster than real time"
            );
            ages.push(queue.age(now));
        }
        eprintln!(
            "bridge queue age after drain, burst of 500 ms then nominal: first ticks {:?}, steady {:?}",
            &ages[..4],
            ages.last().unwrap()
        );
        assert!(ages.iter().all(|age| *age <= BRIDGE_JITTER_WINDOW));
        assert!(ages[1..].iter().all(|age| *age <= BRIDGE_TRIM_TARGET));
        // The last sent frame is the newest-but-trimmed nominal block: no stale burst audio.
        assert!(output.iter().all(|sample| *sample >= 100.0));
    }

    #[test]
    fn untrimmed_backlog_drains_at_real_time_and_keeps_complete_blocks() {
        let start = Instant::now();
        let mut queue = BridgeQueue::default();
        let mut output = Vec::new();
        for index in 0..4 {
            queue.push(block(index as f32), 0, start);
        }
        for tick in 0..4_u32 {
            output.clear();
            queue.drain(0, BLOCK, start + TICK * tick, &mut output);
            assert_eq!(output, block(tick as f32));
        }
        assert_eq!(queue.queued_samples(), 0);
    }

    #[test]
    fn stale_blocks_are_trimmed_whole_and_samples_stay_complete() {
        let start = Instant::now();
        let mut queue = BridgeQueue::default();
        queue.push(vec![1.0; 700], 0, start);
        queue.push(vec![2.0; 300], 0, start);
        let mut output = Vec::new();
        queue.drain(0, 480, start, &mut output);
        assert_eq!(output, vec![1.0; 480]);
        // A large block drained at real time is not stale just because it arrived early.
        output.clear();
        queue.drain(0, 480, start + TICK, &mut output);
        assert_eq!(output.len(), 480);
        // After an encoder stall, the remaining blocks are older than the window.
        output.clear();
        queue.drain(0, 480, start + Duration::from_millis(400), &mut output);
        assert!(output.is_empty());
        assert_eq!(queue.queued_samples(), 0);
    }

    #[test]
    fn a_single_oversized_block_does_not_keep_the_queue_above_the_window() {
        let start = Instant::now();
        let mut queue = BridgeQueue::default();
        // One 1 s payload, the largest the LAN decoder accepts, as a ramp.
        let samples: Vec<f32> = (0..BRIDGE_RATE as usize)
            .map(|index| index as f32)
            .collect();
        queue.push(samples, 0, start);
        let mut output = Vec::new();
        let mut ages = Vec::new();
        for tick in 0..10_u32 {
            let now = start + TICK * tick;
            output.clear();
            queue.drain(0, BLOCK, now, &mut output);
            assert!(output.len() <= BLOCK);
            if tick == 0 {
                // Trimming kept the newest audio: the first frame sent is from the tail.
                assert!(output[0] >= (BRIDGE_RATE as usize - BLOCK * 3) as f32);
                assert_eq!(queue.queued_samples() % BLOCK, 0);
            }
            ages.push(queue.age(now));
        }
        eprintln!("bridge queue age after a single 1 s block: {ages:?}");
        assert!(ages.iter().all(|age| *age <= BRIDGE_TRIM_TARGET));
    }

    #[test]
    fn drain_discards_retired_mute_generations() {
        let start = Instant::now();
        let mut queue = BridgeQueue::default();
        queue.push(block(1.0), 0, start);
        queue.push(block(2.0), 2, start);
        let mut output = Vec::new();
        queue.drain(2, BLOCK, start, &mut output);
        assert_eq!(output, block(2.0));
    }

    #[test]
    fn storage_bound_drops_oldest_whole_blocks() {
        let start = Instant::now();
        let mut queue = BridgeQueue::default();
        for _ in 0..200 {
            queue.push(block(0.0), 0, start);
        }
        assert!(queue.queued_samples() <= BRIDGE_STORAGE_SAMPLES);
        assert_eq!(queue.queued_samples() % BLOCK, 0);
    }

    #[test]
    fn decode_pcm16_matches_the_per_sample_normalization() {
        let pcm = [0x00, 0x80, 0xff, 0x7f, 0x00, 0x00, 0xff, 0xff];
        assert_eq!(decode_pcm16(&pcm), vec![-1.0, 1.0, 0.0, -1.0 / 32_768.0]);
    }
}

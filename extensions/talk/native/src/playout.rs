use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use bytes::Bytes;
use tokio::time::Instant;

use crate::protocol::Event;

const START_PACKETS: usize = 3;
const MAX_SEQUENCE_DISTANCE: usize = 6;
const MAX_PENDING_PACKETS: usize = MAX_SEQUENCE_DISTANCE + 1;

#[derive(Debug, PartialEq)]
pub enum PlayoutFrame {
    Buffering,
    Packet(Bytes),
    Missing,
}

pub struct PacketPlayout {
    pending: BTreeMap<i64, Bytes>,
    expected: Option<i64>,
    playing: bool,
}

pub struct PlayoutClock {
    deadline: Option<Instant>,
}

impl PlayoutClock {
    pub fn new() -> Self {
        Self { deadline: None }
    }

    pub fn start(&mut self, now: Instant) {
        self.deadline.get_or_insert(now);
    }

    pub fn deadline(&self) -> Option<Instant> {
        self.deadline
    }

    pub fn advance(&mut self, samples: usize, sample_rate: u32) {
        let Some(deadline) = self.deadline else {
            return;
        };
        let frame_duration = Duration::from_secs_f64(samples as f64 / sample_rate as f64);
        self.deadline = Some(deadline + frame_duration);
    }

    pub fn stop(&mut self) {
        self.deadline = None;
    }
}

impl PacketPlayout {
    pub fn new() -> Self {
        Self {
            pending: BTreeMap::new(),
            expected: None,
            playing: false,
        }
    }

    pub fn push(&mut self, sequence: u16, payload: Bytes) {
        let expected = *self.expected.get_or_insert(sequence as i64);
        let delta = sequence.wrapping_sub(expected as u16) as i16 as i64;
        let extended = expected + delta;
        if extended < expected {
            if self.playing || expected - extended > MAX_SEQUENCE_DISTANCE as i64 {
                return;
            }
            self.expected = Some(extended);
        } else if extended - expected > MAX_SEQUENCE_DISTANCE as i64 {
            self.pending.clear();
            self.expected = Some(extended);
            self.playing = false;
        }
        self.pending.entry(extended).or_insert(payload);
        while self.pending.len() > MAX_PENDING_PACKETS {
            let Some(oldest) = self.pending.keys().next().copied() else {
                break;
            };
            self.pending.remove(&oldest);
        }
        if !self.playing && self.pending.len() >= START_PACKETS {
            self.playing = true;
        }
    }

    pub fn next(&mut self) -> PlayoutFrame {
        if !self.playing {
            return PlayoutFrame::Buffering;
        }
        let expected = self
            .expected
            .expect("playing playout has an expected sequence");
        let frame = if let Some(payload) = self.pending.remove(&expected) {
            PlayoutFrame::Packet(payload)
        } else if self
            .pending
            .keys()
            .next()
            .is_some_and(|sequence| *sequence > expected)
        {
            PlayoutFrame::Missing
        } else {
            self.playing = false;
            return PlayoutFrame::Buffering;
        };
        self.expected = Some(expected + 1);
        frame
    }

    pub fn ready(&self) -> bool {
        self.playing
    }

    /// Whether a received packet waits behind the frame just taken: evidence
    /// that the stream continues rather than ending.
    pub fn has_buffered(&self) -> bool {
        !self.pending.is_empty()
    }

    pub fn reset(&mut self) {
        self.pending.clear();
        self.expected = None;
        self.playing = false;
    }
}

const UNMARKED: u64 = u64::MAX;

#[derive(Clone, Copy)]
pub enum PlayoutMark {
    Rtp,
    Decode,
    Enqueue,
    Output,
}

/// Diagnostic first-sample timing for one speaker epoch plus the call's
/// underrun count. Lock-free so the output callback can mark it. Records
/// numbers only, never audio.
pub struct PlayoutProbe {
    origin: std::time::Instant,
    epoch: AtomicU64,
    segment_us: AtomicU64,
    marks: [AtomicU64; 4],
    underruns: AtomicU64,
}

impl PlayoutProbe {
    pub fn new() -> Self {
        Self {
            origin: std::time::Instant::now(),
            epoch: AtomicU64::new(0),
            segment_us: AtomicU64::new(0),
            marks: std::array::from_fn(|_| AtomicU64::new(UNMARKED)),
            underruns: AtomicU64::new(0),
        }
    }

    /// Starts timing a new speaker epoch. The underrun count spans the call.
    pub fn begin(&self, epoch: u64, now: std::time::Instant) {
        for mark in &self.marks {
            mark.store(UNMARKED, Ordering::Relaxed);
        }
        self.segment_us.store(self.micros(now), Ordering::Relaxed);
        self.epoch.store(epoch, Ordering::Release);
    }

    /// Records the first occurrence of a stage in `epoch`; returns whether this
    /// call recorded it.
    pub fn mark(&self, mark: PlayoutMark, epoch: u64, now: std::time::Instant) -> bool {
        self.epoch.load(Ordering::Acquire) == epoch
            && self.marks[mark as usize]
                .compare_exchange(
                    UNMARKED,
                    self.micros(now),
                    Ordering::AcqRel,
                    Ordering::Relaxed,
                )
                .is_ok()
    }

    pub fn underrun(&self) -> u64 {
        self.underruns.fetch_add(1, Ordering::AcqRel) + 1
    }

    pub fn underruns(&self) -> u64 {
        self.underruns.load(Ordering::Acquire)
    }

    pub fn stats(&self, epoch: u64, start_threshold_ms: u64) -> Event {
        let segment = self.segment_us.load(Ordering::Relaxed);
        let since_segment = |mark: PlayoutMark| {
            let value = self.marks[mark as usize].load(Ordering::Acquire);
            (value != UNMARKED).then(|| value.saturating_sub(segment))
        };
        Event::PlayoutStats {
            epoch,
            first_rtp_us: since_segment(PlayoutMark::Rtp),
            first_decode_us: since_segment(PlayoutMark::Decode),
            first_enqueue_us: since_segment(PlayoutMark::Enqueue),
            first_output_us: since_segment(PlayoutMark::Output),
            underruns: self.underruns(),
            start_threshold_ms,
        }
    }

    fn micros(&self, now: std::time::Instant) -> u64 {
        u64::try_from(now.saturating_duration_since(self.origin).as_micros())
            .unwrap_or(UNMARKED - 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packet(value: u8) -> Bytes {
        Bytes::from(vec![value])
    }

    #[test]
    fn reorders_packets_and_conceals_a_known_gap() {
        let mut playout = PacketPlayout::new();
        playout.push(12, packet(12));
        playout.push(10, packet(10));
        playout.push(11, packet(11));
        assert_eq!(playout.next(), PlayoutFrame::Packet(packet(10)));
        assert_eq!(playout.next(), PlayoutFrame::Packet(packet(11)));
        assert_eq!(playout.next(), PlayoutFrame::Packet(packet(12)));

        playout.reset();
        assert_eq!(playout.next(), PlayoutFrame::Buffering);

        let mut gap = PacketPlayout::new();
        gap.push(20, packet(20));
        gap.push(22, packet(22));
        gap.push(23, packet(23));
        assert_eq!(gap.next(), PlayoutFrame::Packet(packet(20)));
        assert_eq!(gap.next(), PlayoutFrame::Missing);
        assert_eq!(gap.next(), PlayoutFrame::Packet(packet(22)));
    }

    #[test]
    fn rejects_duplicates_and_orders_across_sequence_wrap() {
        let mut playout = PacketPlayout::new();
        playout.push(u16::MAX, packet(1));
        playout.push(0, packet(2));
        playout.push(0, packet(9));
        playout.push(1, packet(3));
        assert_eq!(playout.next(), PlayoutFrame::Packet(packet(1)));
        assert_eq!(playout.next(), PlayoutFrame::Packet(packet(2)));
        assert_eq!(playout.next(), PlayoutFrame::Packet(packet(3)));
        playout.push(0, packet(4));
        assert_eq!(playout.next(), PlayoutFrame::Buffering);
    }

    #[test]
    fn resynchronizes_after_a_gap_larger_than_the_playout_window() {
        let mut playout = PacketPlayout::new();
        for sequence in 10..=12 {
            playout.push(sequence, packet(sequence as u8));
        }
        assert_eq!(playout.next(), PlayoutFrame::Packet(packet(10)));
        for sequence in 30..=32 {
            playout.push(sequence, packet(sequence as u8));
        }
        assert_eq!(playout.next(), PlayoutFrame::Packet(packet(30)));
    }

    #[test]
    fn retains_every_packet_at_the_inclusive_window_boundary() {
        let mut playout = PacketPlayout::new();
        for sequence in 10..=16 {
            playout.push(sequence, packet(sequence as u8));
        }
        for sequence in 10..=16 {
            assert_eq!(playout.next(), PlayoutFrame::Packet(packet(sequence as u8)));
        }
    }

    #[test]
    fn playout_clock_preserves_media_time_across_a_coarse_wake() {
        let start = Instant::now();
        let mut clock = PlayoutClock::new();
        clock.start(start);
        clock.advance(960, 48_000);

        let coarse_wake = start + Duration::from_millis(31);
        assert!(clock.deadline().unwrap() <= coarse_wake);

        clock.advance(960, 48_000);
        assert_eq!(clock.deadline(), Some(start + Duration::from_millis(40)));
        assert!(clock.deadline().unwrap() > coarse_wake);
    }

    /// Drives packets that arrive every `packet_ms` through playout at a fixed
    /// clock and returns the frames emitted in order, by arrival millisecond.
    fn run(packet_ms: u64, arrivals: &[(u64, u16)]) -> Vec<(u64, PlayoutFrame)> {
        let samples = 48 * packet_ms as usize;
        let base = Instant::now();
        let mut playout = PacketPlayout::new();
        let mut clock = PlayoutClock::new();
        let mut frames = Vec::new();
        let end = arrivals.iter().map(|(at, _)| *at).max().unwrap_or(0) + 4 * packet_ms;
        for now in 0..=end {
            for (_, sequence) in arrivals.iter().filter(|(at, _)| *at == now) {
                playout.push(*sequence, packet(*sequence as u8));
                if playout.ready() {
                    clock.start(base + Duration::from_millis(now));
                }
            }
            while clock
                .deadline()
                .is_some_and(|deadline| deadline <= base + Duration::from_millis(now))
            {
                match playout.next() {
                    PlayoutFrame::Buffering => clock.stop(),
                    frame => {
                        frames.push((now, frame));
                        clock.advance(samples, 48_000);
                    }
                }
            }
        }
        frames
    }

    fn steady(packet_ms: u64, sequences: impl IntoIterator<Item = u16>) -> Vec<(u64, u16)> {
        sequences
            .into_iter()
            .enumerate()
            .map(|(index, sequence)| (index as u64 * packet_ms, sequence))
            .collect()
    }

    #[test]
    fn paces_10_20_and_40_ms_packets_after_the_reorder_window() {
        for packet_ms in [10, 20, 40] {
            let frames = run(packet_ms, &steady(packet_ms, 100..106));
            let start = (START_PACKETS as u64 - 1) * packet_ms;
            let expected: Vec<_> = (0..6)
                .map(|index| {
                    (
                        start + index * packet_ms,
                        PlayoutFrame::Packet(packet(100 + index as u8)),
                    )
                })
                .collect();
            assert_eq!(frames, expected, "{packet_ms} ms packets");
        }
    }

    #[test]
    fn paced_playout_reorders_conceals_loss_and_drops_duplicates() {
        for packet_ms in [10, 20, 40] {
            let arrivals = [
                (0, 1),
                (packet_ms, 3),
                (packet_ms, 1),
                (2 * packet_ms, 2),
                (3 * packet_ms, 5),
                (4 * packet_ms, 6),
                (4 * packet_ms, 5),
                (5 * packet_ms, 7),
            ];
            let frames: Vec<_> = run(packet_ms, &arrivals)
                .into_iter()
                .map(|(_, frame)| frame)
                .collect();
            assert_eq!(
                frames,
                vec![
                    PlayoutFrame::Packet(packet(1)),
                    PlayoutFrame::Packet(packet(2)),
                    PlayoutFrame::Packet(packet(3)),
                    PlayoutFrame::Missing,
                    PlayoutFrame::Packet(packet(5)),
                    PlayoutFrame::Packet(packet(6)),
                    PlayoutFrame::Packet(packet(7)),
                ],
                "{packet_ms} ms packets"
            );
        }
    }

    #[test]
    fn paced_playout_rebuffers_after_a_long_gap() {
        for packet_ms in [10, 20, 40] {
            let gap = 1_000;
            let mut arrivals = steady(packet_ms, 1..4);
            arrivals.extend(
                steady(packet_ms, 200..203)
                    .into_iter()
                    .map(|(at, sequence)| (at + gap, sequence)),
            );
            let frames = run(packet_ms, &arrivals);
            let resumed = gap + (START_PACKETS as u64 - 1) * packet_ms;
            assert_eq!(
                frames[3..],
                [
                    (resumed, PlayoutFrame::Packet(packet(200))),
                    (resumed + packet_ms, PlayoutFrame::Packet(packet(201))),
                    (resumed + 2 * packet_ms, PlayoutFrame::Packet(packet(202))),
                ],
                "{packet_ms} ms packets"
            );
        }
    }

    #[test]
    fn probe_marks_each_stage_once_per_epoch_and_keeps_call_underruns() {
        let probe = PlayoutProbe::new();
        let base = std::time::Instant::now();
        let at = |ms| base + Duration::from_millis(ms);
        probe.begin(3, at(0));
        assert!(probe.mark(PlayoutMark::Rtp, 3, at(5)));
        assert!(!probe.mark(PlayoutMark::Rtp, 3, at(7)));
        assert!(!probe.mark(PlayoutMark::Decode, 2, at(8)));
        assert!(probe.mark(PlayoutMark::Decode, 3, at(45)));
        assert!(probe.mark(PlayoutMark::Enqueue, 3, at(46)));
        assert_eq!(probe.underrun(), 1);
        assert!(probe.mark(PlayoutMark::Output, 3, at(90)));
        assert_eq!(
            serde_json::to_value(probe.stats(3, 40)).unwrap(),
            serde_json::json!({
                "type": "playout_stats",
                "epoch": 3,
                "first_rtp_us": 5_000,
                "first_decode_us": 45_000,
                "first_enqueue_us": 46_000,
                "first_output_us": 90_000,
                "underruns": 1,
                "start_threshold_ms": 40,
            })
        );

        probe.begin(5, at(1_000));
        assert!(!probe.mark(PlayoutMark::Rtp, 3, at(1_001)));
        assert!(probe.mark(PlayoutMark::Rtp, 5, at(1_010)));
        assert_eq!(
            serde_json::to_value(probe.stats(5, 80)).unwrap(),
            serde_json::json!({
                "type": "playout_stats",
                "epoch": 5,
                "first_rtp_us": 10_000,
                "underruns": 1,
                "start_threshold_ms": 80,
            })
        );
    }
}

//! PulseAudio record and playback streams behind cpal's stream interface.
//!
//! Adapted from cpal 0.18.1 `src/host/pulseaudio/stream.rs` and
//! `src/host/latch.rs` (Apache-2.0). See `VENDORED.md`. Changes: the stream
//! takes the cpal sample format from its caller; the readiness latch and the
//! shared error callback are local; only signed and float formats remain, so
//! silence is always zero bytes; samples are realigned when the protocol
//! buffer is not; every server request has a deadline, the latency poll
//! reports a server that stops answering, and dropping a stream waits a
//! bounded time before it aborts the connection.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError, Weak};
use std::thread::{JoinHandle, Thread};
use std::time::{Duration, Instant};

use cpal::traits::StreamTrait;
use cpal::{
    Data, Error, FrameCount, InputCallbackInfo, InputStreamTimestamp, OutputCallbackInfo,
    OutputStreamTimestamp, SampleFormat, StreamInstant,
};
use futures::FutureExt as _;
use futures::executor::block_on;
use pulseaudio::{AsPlaybackSource, protocol};

use super::{Connection, SERVER_TIMEOUT, error, timed_out};

const LATENCY_MAX_INTERVAL: Duration = Duration::from_millis(100);
// f32, the widest sample this helper uses.
const SAMPLE_ALIGN: usize = align_of::<f32>();

type ErrorCallback = Arc<Mutex<dyn FnMut(Error) + Send>>;

fn emit_error(callback: &ErrorCallback, err: Error) {
    (callback.lock().unwrap_or_else(PoisonError::into_inner))(err);
}

/// Sample-aligned storage for protocol buffers that are not aligned.
#[derive(Default)]
struct Scratch(Vec<u32>);

impl Scratch {
    fn bytes(&mut self, len: usize) -> &mut [u8] {
        self.0.resize(len.div_ceil(size_of::<u32>()), 0);
        // SAFETY: the vector holds at least `len` initialized bytes, and u8
        // has no alignment or validity requirements.
        unsafe { std::slice::from_raw_parts_mut(self.0.as_mut_ptr().cast::<u8>(), len) }
    }
}

/// Coordinates a stream's latency polling thread.
struct LatencyHandle {
    cancel: Arc<AtomicBool>,
    // Early wakeup from callbacks and play/pause.
    update: Arc<(Mutex<bool>, Condvar)>,
}

impl LatencyHandle {
    fn new() -> Self {
        Self {
            cancel: Arc::new(AtomicBool::new(false)),
            update: Arc::new((Mutex::new(false), Condvar::new())),
        }
    }

    fn notify(&self) {
        notify(&self.update);
    }

    fn cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
        self.notify();
    }
}

fn notify(update: &(Mutex<bool>, Condvar)) {
    let (lock, cvar) = update;
    *lock.lock().unwrap_or_else(PoisonError::into_inner) = true;
    cvar.notify_one();
}

/// Keeps worker threads from calling back before the caller holds the stream.
struct Latch {
    flag: Option<Arc<AtomicBool>>,
    threads: Vec<Thread>,
}

struct LatchWaiter(Weak<AtomicBool>);

impl Latch {
    fn new() -> Self {
        Self {
            flag: Some(Arc::new(AtomicBool::new(false))),
            threads: Vec::new(),
        }
    }

    fn waiter(&self) -> LatchWaiter {
        LatchWaiter(Arc::downgrade(
            self.flag.as_ref().expect("latch waiter after drop"),
        ))
    }

    fn add_thread(&mut self, thread: Thread) {
        self.threads.push(thread);
    }

    fn release(&self) {
        if let Some(flag) = &self.flag {
            flag.store(true, Ordering::Release);
        }
        for thread in &self.threads {
            thread.unpark();
        }
    }
}

impl Drop for Latch {
    fn drop(&mut self) {
        // Invalidate before unparking, so waiters see the latch is gone.
        drop(self.flag.take());
        for thread in &self.threads {
            thread.unpark();
        }
    }
}

impl LatchWaiter {
    /// Parks until the latch is released, or returns false if it was dropped.
    fn wait(&self) -> bool {
        loop {
            match self.0.upgrade() {
                None => return false,
                Some(flag) if flag.load(Ordering::Acquire) => return true,
                Some(flag) => {
                    drop(flag);
                    std::thread::park();
                }
            }
        }
    }
}

enum StreamInner {
    Playback(pulseaudio::PlaybackStream, Instant, LatencyHandle),
    Record(pulseaudio::RecordStream, Instant, LatencyHandle),
}

pub struct Stream {
    inner: StreamInner,
    connection: Connection,
    workers: Vec<JoinHandle<()>>,
    latch: Latch,
}

impl Drop for Stream {
    fn drop(&mut self) {
        match &mut self.inner {
            StreamInner::Playback(stream, _, handle) => {
                handle.cancel();
                // Deleting the stream ends the play_all driver, whose source
                // never reports an empty buffer.
                let _ = stream.clone().delete().now_or_never();
            }
            StreamInner::Record(_, _, handle) => handle.cancel(),
        }
        self.signal_ready();
        // An error callback on a worker may drop the stream; never join the
        // current thread.
        let current = std::thread::current().id();
        self.workers
            .retain(|worker| worker.thread().id() != current);
        // Workers end once the server acknowledges the delete. If it does
        // not answer in time, abort the connection, which ends them too.
        let deadline = Instant::now() + SERVER_TIMEOUT;
        while !self.workers.iter().all(JoinHandle::is_finished) {
            if Instant::now() >= deadline {
                self.connection.abort();
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
    }
}

impl StreamTrait for Stream {
    fn play(&self) -> Result<(), Error> {
        match &self.inner {
            StreamInner::Playback(stream, _, handle) => {
                let stream = stream.clone();
                self.connection
                    .call(move |_| block_on(stream.uncork()))
                    .ok_or_else(timed_out)?
                    .map_err(error)?;
                handle.notify();
            }
            StreamInner::Record(stream, _, handle) => {
                let stream = stream.clone();
                self.connection
                    .call(move |_| {
                        block_on(async {
                            stream.uncork().await?;
                            stream.started().await
                        })
                    })
                    .ok_or_else(timed_out)?
                    .map_err(error)?;
                handle.notify();
            }
        }
        Ok(())
    }

    fn pause(&self) -> Result<(), Error> {
        let handle = match &self.inner {
            StreamInner::Playback(stream, _, handle) => {
                let stream = stream.clone();
                self.connection
                    .call(move |_| block_on(stream.cork()))
                    .ok_or_else(timed_out)?
                    .map_err(error)?;
                handle
            }
            StreamInner::Record(stream, _, handle) => {
                let stream = stream.clone();
                self.connection
                    .call(move |_| block_on(stream.cork()))
                    .ok_or_else(timed_out)?
                    .map_err(error)?;
                handle
            }
        };
        handle.notify();
        Ok(())
    }

    fn now(&self) -> StreamInstant {
        let (StreamInner::Playback(_, start, _) | StreamInner::Record(_, start, _)) = &self.inner;
        instant(start.elapsed())
    }

    fn buffer_size(&self) -> Result<FrameCount, Error> {
        let (spec, bytes) = match &self.inner {
            StreamInner::Playback(stream, _, _) => (
                stream.sample_spec(),
                stream.buffer_attr().minimum_request_length as usize,
            ),
            StreamInner::Record(stream, _, _) => (
                stream.sample_spec(),
                stream.buffer_attr().fragment_size as usize,
            ),
        };
        let frame = spec.channels as usize * spec.format.bytes_per_sample();
        Ok((bytes / frame.max(1)) as FrameCount)
    }
}

fn instant(elapsed: Duration) -> StreamInstant {
    StreamInstant::new(elapsed.as_secs(), elapsed.subsec_nanos())
}

/// The server's latency report for a stream: device latency in microseconds,
/// then the write and read offsets.
type Timing = (u64, i64, i64);

/// Polls the server's timing for one stream until cancelled, waking early
/// after each callback. A server that stops answering aborts the connection
/// and is reported, since the stream would otherwise stall silently.
#[allow(clippy::too_many_arguments)]
fn spawn_latency_thread(
    waiter: LatchWaiter,
    handle: &LatencyHandle,
    connection: Connection,
    start: Instant,
    spec: protocol::SampleSpec,
    latency_micros: Arc<AtomicU64>,
    poll_micros: Arc<AtomicU64>,
    timing: impl Fn() -> Result<Timing, pulseaudio::ClientError> + Send + Sync + 'static,
    errors: ErrorCallback,
) -> JoinHandle<()> {
    let cancel = Arc::clone(&handle.cancel);
    let update = Arc::clone(&handle.update);
    let timing = Arc::new(timing);
    std::thread::spawn(move || {
        if !waiter.wait() {
            return;
        }
        while !cancel.load(Ordering::Relaxed) {
            let poll = Arc::clone(&timing);
            let reply = connection.call(move |_| poll());
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            let (device_usec, write_offset, read_offset) = match reply {
                Some(Ok(timing)) => timing,
                Some(Err(err)) => {
                    emit_error(&errors, error(err));
                    break;
                }
                None => {
                    emit_error(&errors, timed_out());
                    break;
                }
            };
            poll_micros.store(
                Instant::now().saturating_duration_since(start).as_micros() as u64,
                Ordering::Relaxed,
            );
            let queued = (write_offset - read_offset).max(0) as usize;
            let latency = Duration::from_micros(device_usec) + spec.bytes_to_duration(queued);
            latency_micros.store(
                latency.as_micros().try_into().unwrap_or(u64::MAX),
                Ordering::Relaxed,
            );
            let (lock, cvar) = &*update;
            let Ok(guard) = lock.lock() else { break };
            let (mut guard, _) = cvar
                .wait_timeout_while(guard, LATENCY_MAX_INTERVAL, |notified| !*notified)
                .unwrap_or_else(PoisonError::into_inner);
            *guard = false;
        }
    })
}

/// The latency at `elapsed`, interpolated from the last poll for at most
/// LATENCY_MAX_INTERVAL. Playback latency drains as audio plays; capture
/// latency grows as audio arrives.
fn interpolated(latency: &AtomicU64, poll: &AtomicU64, elapsed: Duration, draining: bool) -> u64 {
    let since_poll = (elapsed.as_micros() as u64)
        .saturating_sub(poll.load(Ordering::Relaxed))
        .min(LATENCY_MAX_INTERVAL.as_micros() as u64);
    let latency = latency.load(Ordering::Relaxed);
    if draining {
        latency.saturating_sub(since_poll)
    } else {
        latency.saturating_add(since_poll)
    }
}

impl Stream {
    pub fn new_playback<D, E>(
        connection: Connection,
        params: protocol::PlaybackStreamParams,
        format: SampleFormat,
        mut data_callback: D,
        error_callback: E,
    ) -> Result<Self, Error>
    where
        D: FnMut(&mut Data, &OutputCallbackInfo) + Send + 'static,
        E: FnMut(Error) + Send + 'static,
    {
        let start = Instant::now();
        let spec = params.sample_spec;
        let latency = Arc::new(AtomicU64::new(0));
        let poll = Arc::new(AtomicU64::new(0));
        let handle = LatencyHandle::new();
        let callback_latency = Arc::clone(&latency);
        let callback_poll = Arc::clone(&poll);
        let callback_update = Arc::clone(&handle.update);
        let mut scratch = Scratch::default();
        let callback = move |buffer: &mut [u8]| {
            let elapsed = Instant::now().saturating_duration_since(start);
            let latency = interpolated(&callback_latency, &callback_poll, elapsed, true);
            let info = OutputCallbackInfo::new(OutputStreamTimestamp {
                callback: instant(elapsed),
                playback: instant(elapsed + Duration::from_micros(latency)),
            });
            let aligned = buffer.as_ptr().align_offset(SAMPLE_ALIGN) == 0;
            let samples: &mut [u8] = if aligned {
                &mut *buffer
            } else {
                scratch.bytes(buffer.len())
            };
            // cpal callbacks fill whole buffers; start from silence anyway.
            samples.fill(0);
            let count = samples.len() / spec.format.bytes_per_sample();
            // SAFETY: `samples` is aligned for `format` and holds `count`
            // whole samples of `spec.format`, which the device derived from
            // `format`.
            let mut data = unsafe { Data::from_parts(samples.as_mut_ptr().cast(), count, format) };
            data_callback(&mut data, &info);
            if !aligned {
                let len = buffer.len();
                buffer.copy_from_slice(&scratch.bytes(len)[..]);
            }
            notify(&callback_update);
            buffer.len()
        };
        let source = callback.as_playback_source();
        let client = connection.client.clone();
        let stream = block_on(client.create_playback_stream(params, source)).map_err(error)?;

        let errors: ErrorCallback = Arc::new(Mutex::new(error_callback));
        let mut latch = Latch::new();
        let driver_stream = stream.clone();
        let driver_errors = Arc::clone(&errors);
        let driver_cancel = Arc::clone(&handle.cancel);
        let driver_waiter = latch.waiter();
        let driver = std::thread::spawn(move || {
            if !driver_waiter.wait() {
                return;
            }
            // The server reports an error when the stream is closed on purpose.
            if let Err(err) = block_on(driver_stream.play_all())
                && !driver_cancel.load(Ordering::Relaxed)
            {
                emit_error(&driver_errors, error(err));
            }
        });
        let timing_stream = stream.clone();
        let latency_thread = spawn_latency_thread(
            latch.waiter(),
            &handle,
            connection.clone(),
            start,
            spec,
            latency,
            poll,
            move || {
                block_on(timing_stream.timing_info())
                    .map(|info| (info.sink_usec, info.write_offset, info.read_offset))
            },
            errors,
        );
        latch.add_thread(driver.thread().clone());
        latch.add_thread(latency_thread.thread().clone());
        Ok(Self {
            inner: StreamInner::Playback(stream, start, handle),
            connection,
            workers: vec![driver, latency_thread],
            latch,
        })
    }

    pub fn new_record<D, E>(
        connection: Connection,
        params: protocol::RecordStreamParams,
        format: SampleFormat,
        mut data_callback: D,
        error_callback: E,
    ) -> Result<Self, Error>
    where
        D: FnMut(&Data, &InputCallbackInfo) + Send + 'static,
        E: FnMut(Error) + Send + 'static,
    {
        let start = Instant::now();
        let spec = params.sample_spec;
        let latency = Arc::new(AtomicU64::new(0));
        let poll = Arc::new(AtomicU64::new(0));
        let handle = LatencyHandle::new();
        let callback_latency = Arc::clone(&latency);
        let callback_poll = Arc::clone(&poll);
        let callback_update = Arc::clone(&handle.update);
        let mut scratch = Scratch::default();
        let callback = move |buffer: &[u8]| {
            let elapsed = Instant::now().saturating_duration_since(start);
            let latency = interpolated(&callback_latency, &callback_poll, elapsed, false);
            let info = InputCallbackInfo::new(InputStreamTimestamp {
                callback: instant(elapsed),
                capture: instant(
                    elapsed
                        .checked_sub(Duration::from_micros(latency))
                        .unwrap_or_default(),
                ),
            });
            let samples: &[u8] = if buffer.as_ptr().align_offset(SAMPLE_ALIGN) == 0 {
                buffer
            } else {
                let copy = scratch.bytes(buffer.len());
                copy.copy_from_slice(buffer);
                copy
            };
            let count = samples.len() / spec.format.bytes_per_sample();
            // SAFETY: `samples` is aligned for `format` and holds `count`
            // whole samples of `spec.format`, which the device derived from
            // `format`. cpal exposes input data only through shared slices,
            // so the cast to a mutable pointer is never written through.
            let data = unsafe { Data::from_parts(samples.as_ptr() as *mut _, count, format) };
            data_callback(&data, &info);
            notify(&callback_update);
        };
        let client = connection.client.clone();
        let stream = block_on(client.create_record_stream(params, callback)).map_err(error)?;

        let errors: ErrorCallback = Arc::new(Mutex::new(error_callback));
        let mut latch = Latch::new();
        let timing_stream = stream.clone();
        let latency_thread = spawn_latency_thread(
            latch.waiter(),
            &handle,
            connection.clone(),
            start,
            spec,
            latency,
            poll,
            move || {
                block_on(timing_stream.timing_info())
                    .map(|info| (info.source_usec, info.write_offset, info.read_offset))
            },
            errors,
        );
        latch.add_thread(latency_thread.thread().clone());
        Ok(Self {
            inner: StreamInner::Record(stream, start, handle),
            connection,
            workers: vec![latency_thread],
            latch,
        })
    }

    /// Lets the worker threads start calling back.
    pub fn signal_ready(&self) {
        self.latch.release();
    }
}

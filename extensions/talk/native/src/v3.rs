use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::Value;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, watch};
use webrtc::api::APIBuilder;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;

use crate::audio::{self, Capture, Playback, SpeakerState};
use crate::protocol::{Event, MAX_DATA_MESSAGE_BYTES};
use crate::v3_media::{
    DeviceEncoder, InputControl, OutputSink, create_audio_sender, register_playout,
    spawn_bridge_encoder, spawn_device_encoder,
};

/// Deadline for one data-channel send. A send that misses it is reported, not retried.
const DATA_SEND_TIMEOUT: Duration = Duration::from_secs(1);
/// Byte budget for data-channel messages accepted but not yet sent.
const DATA_SEND_QUEUE_BYTES: usize = 1024 * 1024;

pub struct V3Session {
    peer: Arc<RTCPeerConnection>,
    data: DataSender,
    rtcp_task: tokio::task::JoinHandle<()>,
    encoder_task: tokio::task::JoinHandle<()>,
    input: InputControl,
    speaker: Arc<SpeakerState>,
    speaker_tx: watch::Sender<audio::SpeakerControl>,
    _capture: Option<Capture>,
    playback: Option<Playback>,
}

impl V3Session {
    pub async fn create_devices(
        microphone: Option<String>,
        speaker: Option<String>,
        events: mpsc::Sender<Event>,
    ) -> Result<(Self, String)> {
        let capture = audio::capture(microphone.as_deref())?;
        let playback = audio::playback(speaker.as_deref(), events.clone())?;
        let output = OutputSink::Device {
            samples: Arc::clone(&playback.samples),
            sample_rate: playback.sample_rate,
        };
        Self::create(output, events, Some(capture), Some(playback)).await
    }

    pub async fn create_bridge(events: mpsc::Sender<Event>) -> Result<(Self, String)> {
        Self::create(OutputSink::Bridge, events, None, None).await
    }

    async fn create(
        output: OutputSink,
        events: mpsc::Sender<Event>,
        capture: Option<Capture>,
        playback: Option<Playback>,
    ) -> Result<(Self, String)> {
        let mut media_engine = MediaEngine::default();
        media_engine.register_default_codecs()?;
        let registry = register_default_interceptors(Registry::new(), &mut media_engine)?;
        let api = APIBuilder::new()
            .with_media_engine(media_engine)
            .with_interceptor_registry(registry)
            .build();
        let peer = Arc::new(api.new_peer_connection(RTCConfiguration::default()).await?);

        let (track, rtcp_task) = create_audio_sender(&peer).await?;

        let input_enabled = Arc::new(AtomicBool::new(false));
        let data_channel = peer.create_data_channel("oai-events", None).await?;
        let open_events = events.clone();
        let open_input = Arc::clone(&input_enabled);
        data_channel.on_open(Box::new(move || {
            let open_events = open_events.clone();
            let open_input = Arc::clone(&open_input);
            Box::pin(async move {
                open_input.store(true, Ordering::Release);
                let _ = open_events.send(Event::State { state: "ready" }).await;
            })
        }));
        let message_events = events.clone();
        data_channel.on_message(Box::new(move |message: DataChannelMessage| {
            let message_events = message_events.clone();
            Box::pin(async move {
                if message.data.len() > MAX_DATA_MESSAGE_BYTES {
                    return;
                }
                match serde_json::from_slice::<Value>(&message.data) {
                    Ok(message) => {
                        let _ = message_events.send(Event::Data { message }).await;
                    }
                    Err(error) => {
                        let _ = message_events
                            .send(Event::Error {
                                message: format!("invalid realtime data event: {error}"),
                            })
                            .await;
                    }
                }
            })
        }));
        let state_events = events.clone();
        peer.on_peer_connection_state_change(Box::new(move |state: RTCPeerConnectionState| {
            let state_events = state_events.clone();
            Box::pin(async move {
                let state = match state {
                    RTCPeerConnectionState::Connected => Some("connected"),
                    RTCPeerConnectionState::Disconnected => Some("disconnected"),
                    RTCPeerConnectionState::Failed => Some("failed"),
                    RTCPeerConnectionState::Closed => Some("closed"),
                    _ => None,
                };
                if let Some(state) = state {
                    let _ = state_events.send(Event::State { state }).await;
                }
            })
        }));

        let speaker = playback
            .as_ref()
            .map(|playback| Arc::clone(&playback.state))
            .unwrap_or_else(|| Arc::new(SpeakerState::new()));
        let (speaker_tx, speaker_rx) = watch::channel(speaker.get());
        register_playout(
            &peer,
            output,
            events.clone(),
            Arc::clone(&speaker),
            speaker_rx,
        );

        let (input, encoder_task) = if let Some(capture) = &capture {
            let playback = playback
                .as_ref()
                .context("device capture requires device playback")?;
            spawn_device_encoder(
                track,
                DeviceEncoder {
                    frames: Arc::clone(&capture.frames),
                    input_rate: capture.sample_rate,
                    generation: Arc::clone(&capture.generation),
                    dropped: Arc::clone(&capture.dropped),
                    failed: Arc::clone(&capture.failed),
                    rendered: Arc::clone(&playback.rendered),
                    output_rate: playback.sample_rate,
                    render_dropped: Arc::clone(&playback.render_dropped),
                    speaker: Arc::clone(&speaker),
                },
                input_enabled,
                events.clone(),
            )
        } else {
            spawn_bridge_encoder(track, input_enabled, events.clone())
        };
        let data = DataSender::spawn(
            move |text| {
                let data_channel = Arc::clone(&data_channel);
                async move {
                    data_channel.send_text(text).await?;
                    Ok(())
                }
            },
            DATA_SEND_TIMEOUT,
            events,
        );

        let offer = peer.create_offer(None).await?;
        let mut gather = peer.gathering_complete_promise().await;
        peer.set_local_description(offer).await?;
        gather.recv().await;
        let sdp = peer
            .local_description()
            .await
            .context("WebRTC offer was not created")?
            .sdp;
        Ok((
            Self {
                peer,
                data,
                rtcp_task,
                encoder_task,
                input,
                speaker,
                speaker_tx,
                _capture: capture,
                playback,
            },
            sdp,
        ))
    }

    pub async fn apply_answer(&self, sdp: String) -> Result<()> {
        self.peer
            .set_remote_description(RTCSessionDescription::answer(sdp)?)
            .await?;
        Ok(())
    }

    /// Queue a data-channel message without waiting for the send.
    pub fn send(&self, message: Value) -> Result<()> {
        self.data.enqueue(serde_json::to_string(&message)?)
    }

    pub async fn set_input_muted(&self, muted: bool) -> Result<()> {
        self.input.set_muted(muted).await
    }

    pub fn set_speaker_suppressed(&mut self, suppressed: bool, epoch: u64) -> Result<()> {
        if let Some(playback) = &mut self.playback {
            let result = playback.transition(suppressed, epoch);
            let current = self.speaker.get();
            if current.epoch == epoch {
                self.speaker_tx.send_replace(current);
            }
            result?;
        } else {
            let current = self.speaker.transition(suppressed, epoch)?;
            self.speaker_tx.send_replace(current);
        }
        Ok(())
    }

    pub fn send_pcm(&self, pcm: &[u8]) -> Result<()> {
        self.input.push_bridge_pcm(pcm)
    }

    pub async fn close(self) -> Result<()> {
        self.rtcp_task.abort();
        self.encoder_task.abort();
        let _ = self.rtcp_task.await;
        let _ = self.encoder_task.await;
        self.data.close().await;
        self.peer.close().await?;
        Ok(())
    }
}

type QueuedData = (String, OwnedSemaphorePermit);

/// Sends data-channel messages in order off the command loop. Each send has a
/// deadline so a stalled channel cannot hold later PCM, control, or stop commands.
struct DataSender {
    queue: mpsc::UnboundedSender<QueuedData>,
    budget: Arc<Semaphore>,
    task: tokio::task::JoinHandle<()>,
}

impl DataSender {
    fn spawn<F, Fut>(send: F, timeout: Duration, events: mpsc::Sender<Event>) -> Self
    where
        F: Fn(String) -> Fut + Send + 'static,
        Fut: Future<Output = Result<()>> + Send,
    {
        let (queue, mut queued) = mpsc::unbounded_channel::<QueuedData>();
        let task = tokio::spawn(async move {
            while let Some((text, _permit)) = queued.recv().await {
                let message = match tokio::time::timeout(timeout, send(text)).await {
                    Ok(Ok(())) => continue,
                    Ok(Err(error)) => format!("{error:#}"),
                    Err(_) => {
                        // Delivery of the abandoned message is uncertain; never retry it
                        // or send later messages after it.
                        let _ = events
                            .send(Event::Error {
                                message: "realtime data channel send timed out".to_owned(),
                            })
                            .await;
                        return;
                    }
                };
                let _ = events.send(Event::Error { message }).await;
            }
        });
        Self {
            queue,
            budget: Arc::new(Semaphore::new(DATA_SEND_QUEUE_BYTES)),
            task,
        }
    }

    fn enqueue(&self, text: String) -> Result<()> {
        let permit = u32::try_from(text.len().max(1))
            .ok()
            .and_then(|bytes| Arc::clone(&self.budget).try_acquire_many_owned(bytes).ok())
            .with_context(|| {
                format!("realtime data channel backlog exceeds {DATA_SEND_QUEUE_BYTES} bytes")
            })?;
        self.queue
            .send((text, permit))
            .map_err(|_| anyhow::anyhow!("realtime data channel sender stopped"))
    }

    async fn close(self) {
        self.task.abort();
        let _ = self.task.await;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::time::Instant;

    use super::*;

    #[tokio::test]
    async fn blocked_data_send_does_not_delay_stop_past_its_deadline() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&sent);
        let (events, mut event_rx) = mpsc::channel(8);
        let deadline = Duration::from_millis(50);
        let sender = DataSender::spawn(
            move |text: String| {
                let recorded = Arc::clone(&recorded);
                async move {
                    if text == "\"blocked\"" {
                        std::future::pending::<()>().await;
                    }
                    recorded.lock().unwrap().push(text);
                    Ok(())
                }
            },
            deadline,
            events,
        );
        let started = Instant::now();
        sender.enqueue("\"blocked\"".to_owned()).unwrap();
        sender.enqueue("\"after\"".to_owned()).unwrap();
        // Enqueueing never awaits the channel, so the command loop reaches stop at once.
        assert!(started.elapsed() < deadline);
        sender.close().await;
        assert!(
            started.elapsed() < deadline,
            "stop waited {:?}",
            started.elapsed()
        );
        assert!(sent.lock().unwrap().is_empty());
        assert!(event_rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn data_sends_keep_order_and_report_missed_deadlines() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&sent);
        let (events, mut event_rx) = mpsc::channel(8);
        let deadline = Duration::from_millis(30);
        let sender = DataSender::spawn(
            move |text: String| {
                let recorded = Arc::clone(&recorded);
                async move {
                    if text == "\"blocked\"" {
                        std::future::pending::<()>().await;
                    }
                    tokio::task::yield_now().await;
                    recorded.lock().unwrap().push(text);
                    Ok(())
                }
            },
            deadline,
            events,
        );
        for text in ["\"one\"", "\"two\"", "\"blocked\"", "\"never\""] {
            sender.enqueue(text.to_owned()).unwrap();
        }
        let started = Instant::now();
        let event = tokio::time::timeout(Duration::from_secs(1), event_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(started.elapsed() >= deadline);
        assert!(
            matches!(event, Event::Error { ref message } if message == "realtime data channel send timed out")
        );
        assert_eq!(*sent.lock().unwrap(), vec!["\"one\"", "\"two\""]);
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(sender.enqueue("\"later\"".to_owned()).is_err());
        sender.close().await;
    }

    #[tokio::test]
    async fn data_backlog_is_bounded_by_bytes() {
        let (events, _event_rx) = mpsc::channel(8);
        let sender = DataSender::spawn(
            |_text: String| async {
                std::future::pending::<()>().await;
                Ok(())
            },
            Duration::from_secs(60),
            events,
        );
        let message = "x".repeat(64 * 1024);
        let accepted = (0..32)
            .take_while(|_| sender.enqueue(message.clone()).is_ok())
            .count();
        assert_eq!(accepted, DATA_SEND_QUEUE_BYTES / message.len());
        sender.close().await;
    }
}

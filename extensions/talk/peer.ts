/** Audio stays in the peer; Pi handles authenticated signaling and task events. */
export interface RtcPeer {
  url?: string;
  offer: Promise<string>;
  applyAnswer(sdp: string): void;
  sendData(event: unknown): void;
  /** Gate microphone and speaker together; absent when unsupported. Errors are terminal. */
  setAudioEnabled?(enabled: boolean): void;
  close(): Promise<void>;
}

export interface PeerCallbacks {
  onEvent(event: unknown): void;
  onReady(): void;
  onError(error: Error): void;
  onClosed(): void;
}

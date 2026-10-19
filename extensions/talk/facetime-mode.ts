import { mkdirSync, readdirSync, rmdirSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createFaceTimeClient, faceTimeRecord, faceTimeSemanticEvent, faceTimeSocketPath, validateFaceTimeSnapshot,
  type FaceTimeClient, type FaceTimeClientCallbacks, type FaceTimeClientOptions, type FaceTimeRecord, type FaceTimeSnapshot,
} from "./facetime-client.ts";

import { faceTimeCallMedia, validateFaceTimeCallPurpose, type FaceTimeCallMedia } from "./facetime-call.ts";

export interface FaceTimeVoiceHandle {
  setAudioEnabled(enabled: boolean): void;
  introduceOutgoingCall?(purpose?: string): void;
  stop(): Promise<void>;
}
export interface FaceTimeStatus {
  enabled: boolean;
  phase: string;
  /** Whether the external control service is available (not call connection evidence). */
  connected: boolean;
  identity?: string;
  error?: string;
  callId?: string;
  serviceInstanceId?: string;
  audioEnabled?: boolean;
  /** Outgoing intent, not evidence of a video stream or remote camera state. */
  requestedMedia?: FaceTimeCallMedia;
  /** Media label observed by the native call tracker, if available. */
  observedMedia?: FaceTimeCallMedia;
}
export interface FaceTimeModeOptions {
  socketPath?: string;
  /** Shared config selected by Pi; the GUI service must explicitly use the same file. */
  configPath?: string;
  /** Must create an OWNED voice session with both audio directions initially gated. Honor abort. */
  prepareVoice(signal: AbortSignal): Promise<FaceTimeVoiceHandle>;
  /** Sole owner address loaded from the private shared config; never model-selected. */
  recipient: string;
  routing: { input: string; output: string };
  onStatus?(status: FaceTimeStatus): void;
  /** Read-only consumers must invalidate on every ownership/readiness edge. */
  onAuthorityChange?(): void;
  onEvent?(event: Record<string, unknown>): void;
  /** Only an observed terminal event for a call owned by this mode. */
  onCallEnded?(event: Record<string, unknown>): void;
  onError?(error: Error): void;
  /** Test boundary: callbacks have the same metadata/ordering contract as the real client. */
  createClient?(callbacks: FaceTimeClientCallbacks): FaceTimeClient;
  clientOptions?: Pick<FaceTimeClientOptions, "requestTimeoutMs" | "snapshotTimeoutMs" | "reconnectMinMs" | "reconnectMaxMs">;
  acquireLease?(socketPath: string): () => void;
}
export interface FaceTimeMode {
  enable(): Promise<void>;
  disable(): Promise<void>;
  status(): FaceTimeStatus;
  /** Private evidence only; never wire these identifiers to a renderer. */
  presentationAuthority?(): { callKey: string } | undefined;
  call(purpose?: string, media?: FaceTimeCallMedia): Promise<unknown>;
  answer(): Promise<unknown>;
  hangup(): Promise<unknown>;
  /** Explicit request only: share one entire screen by exact display name, never grant remote control. */
  shareScreen(display: string): Promise<unknown>;
  /** Explicit request only; both sharing mutations require an owned, verified connected call. */
  stopSharing(): Promise<unknown>;
  voiceEnded(): Promise<void>;
}

/**
 * Atomic directory lease. PID/token are encoded in one EMPTY child directory.
 * Recovery uses rmdir, never unlink/recursive removal/rename: it cannot delete a
 * populated replacement lease. An empty, malformed, symlinked or EPERM lease is
 * deliberately not recovered. PID reuse also fails closed.
 */
export function acquireFaceTimeLease(socketPath: string): () => void {
  const path = faceTimeSocketPath(socketPath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = join(realpathSync(dirname(path)), `${path.slice(path.lastIndexOf("/") + 1)}.owner`);
  const marker = `${process.pid}-${randomUUID()}`;
  function make() {
    mkdirSync(lock, { mode: 0o700 });
    // A crash between these operations leaves an ambiguous lease: fail closed.
    mkdirSync(join(lock, marker), { mode: 0o700 });
  }
  try { make(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const busy = () => new Error(`FaceTime controller ownership is held or ambiguous at ${lock}; stop the owning Pi process (remove only a confirmed stale lease manually)`);
    try {
      if (!lstatSync(lock).isDirectory() || lstatSync(lock).isSymbolicLink()) throw busy();
      const names = readdirSync(lock);
      if (names.length !== 1) throw busy();
      const match = /^([1-9]\d*)-[0-9a-f-]{36}$/.exec(names[0]);
      const pid = match ? Number(match[1]) : 0;
      if (!Number.isSafeInteger(pid) || pid <= 0 || !lstatSync(join(lock, names[0])).isDirectory()) throw busy();
      try { process.kill(pid, 0); throw busy(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw busy(); }
      // Only one recovering contender can remove this exact empty marker.
      rmdirSync(join(lock, names[0]));
      rmdirSync(lock);
      make();
    } catch { throw busy(); }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // Never remove a successor's marker or recursively clean an unknown path.
    try { rmdirSync(join(lock, marker)); } catch { return; }
    try { rmdirSync(lock); } catch { /* Unexpected contents remain for inspection. */ }
  };
}

interface OwnedCall {
  generation: string;
  instance: string;
  id?: string;
  identity?: string;
  direction: "incoming" | "outgoing";
  purpose?: string;
  requestedMedia?: FaceTimeCallMedia;
  controller: AbortController;
  voice?: FaceTimeVoiceHandle;
  preparation?: Promise<void>;
  action?: Promise<unknown>;
  answerSent: boolean;
  callSent: boolean;
  hangupSent: boolean;
  endingRequest?: Promise<unknown>;
  callRequest?: Promise<unknown>;
  ending: boolean;
  verified: boolean;
  audio: boolean;
  introduced?: boolean;
  /** Native failure closed voice but still owns UI; never resume this call. */
  retained?: boolean;
}
function safe(fn: () => void) { try { fn(); } catch { /* Notifications do not own lifecycle. */ } }
function asError(value: unknown): Error { return value instanceof Error ? value : new Error("FaceTime operation failed"); }
function callId(record: FaceTimeRecord): string | undefined { return typeof record.callId === "string" && record.callId ? record.callId : undefined; }
function active(record: FaceTimeRecord): boolean { return record.phase !== "idle" || callId(record) !== undefined; }

/** Single controller, one owned voice/call at a time; never starts the Swift service or aborts Pi work. */
export function createFaceTimeMode(options: FaceTimeModeOptions): FaceTimeMode {
  const socketPath = faceTimeSocketPath(options.socketPath);
  const routing = { ...options.routing };
  if (![routing.input, routing.output].every((v) => typeof v === "string" && v.trim().length > 0)) throw new Error("FaceTime requires exact input and output device names");
  let state: FaceTimeStatus = { enabled: false, phase: "disabled", connected: false, audioEnabled: false };
  let client: FaceTimeClient | undefined;
  let release: (() => void) | undefined;
  let enabling: Promise<void> | undefined;
  let disabling: Promise<void> | undefined;
  let run = 0;
  let connection = 0;
  let ready = false;
  let initialized = false;
  let instance: string | undefined;
  let seq = -1;
  let observed: FaceTimeRecord = { phase: "idle" };
  let supportsVideoCalls = false;
  let blocked: string | undefined;
  let owned: OwnedCall | undefined;
  const stopping = new Set<Promise<void>>();
  const stoppedVoices = new WeakSet<FaceTimeVoiceHandle>();

  function authorityChanged() { safe(() => options.onAuthorityChange?.()); }
  function presentationAuthority(): { callKey: string } | undefined {
    const session = owned;
    if (!session || !live(session) || !state.connected || !session.verified || !session.audio || !session.voice
      || !session.id || session.id !== callId(observed) || observed.phase !== "connected" || observed.verified !== true) return undefined;
    return { callKey: JSON.stringify([session.instance, session.id, session.generation]) };
  }
  function publish(phase: string, error?: string) {
    authorityChanged();
    state = {
      enabled: state.enabled, connected: state.connected, phase,
      serviceInstanceId: instance, callId: owned?.id ?? callId(observed),
      identity: owned?.identity ?? (typeof observed.identity === "string" ? observed.identity : undefined),
      audioEnabled: owned?.audio ?? false,
      requestedMedia: owned?.requestedMedia,
      observedMedia: observed.media === "audio" || observed.media === "video" ? observed.media : undefined,
      ...(error ? { error } : {}),
    };
    safe(() => options.onStatus?.({ ...state }));
  }
  function report(error: unknown) { safe(() => options.onError?.(asError(error))); }
  function stopVoice(voice: FaceTimeVoiceHandle): Promise<void> {
    if (stoppedVoices.has(voice)) return Promise.resolve();
    stoppedVoices.add(voice);
    try { voice.setAudioEnabled(false); } catch (error) { report(error); }
    let promise: Promise<void>;
    try { promise = Promise.resolve(voice.stop()).catch(report); }
    catch (error) { report(error); promise = Promise.resolve(); }
    stopping.add(promise);
    void promise.finally(() => stopping.delete(promise));
    return promise;
  }
  function cancelVoice(session: OwnedCall) {
    session.audio = false;
    authorityChanged();
    const voice = session.voice;
    session.voice = undefined;
    // Gate before abort handlers can tear down the native peer/voice handle.
    if (voice) void stopVoice(voice);
    session.controller.abort();
  }
  function forget() {
    const previous = owned;
    owned = undefined;
    if (previous) cancelVoice(previous);
  }
  function live(session: OwnedCall): boolean {
    return state.enabled && ready && owned === session && !session.controller.signal.aborted && !session.ending && !session.retained
      && instance === session.instance;
  }
  function standby() {
    publish(!state.connected ? "unavailable" : observed.phase === "unconfirmed" || owned?.retained ? "unconfirmed" : active(observed) ? "busy" : "standby");
  }
  function retain(session: OwnedCall) {
    session.retained = true;
    session.verified = false;
    cancelVoice(session);
  }
  function validatePolicy(snapshot: FaceTimeSnapshot, checkRouting = true) {
    if (faceTimeRecord(snapshot.permission).trusted !== true) throw new Error("FaceTime Accessibility permission is not trusted; enable the external service in System Settings > Privacy & Security > Accessibility");
    const configuration = faceTimeRecord(snapshot.configuration);
    if (options.configPath && (typeof configuration.configPath !== "string" || resolve(configuration.configPath) !== resolve(options.configPath))) {
      throw new Error(`FaceTime bridge must use the shared Talk config at ${options.configPath}. Update the app if needed, choose that file in its menu, then stop/start the service.`);
    }
    if (configuration.autoAnswer !== false) throw new Error("FaceTime service must have autoAnswer=false; Pi controls readiness. Restart the service with auto-answer disabled");
    // Snapshot device names use the managed visible Pi Talk endpoint in both directions.
    if (!checkRouting) return;
    for (const section of ["input", "output"] as const) {
      const configured = configuration[`${section}Device`];
      if (configured != null && configured !== routing[section]) throw new Error(`FaceTime service ${section}Device conflicts with Pi routing; update its configuration and restart the service`);
    }
  }
  async function configureRouting(current: FaceTimeClient, valid: () => boolean, select = true) {
    try {
      if (!valid()) throw new Error("FaceTime routing cancelled");
      // Select only on explicit enable. Reconnect is read-only reconciliation,
      // including when its snapshot reveals an unrelated/manual active call.
      if (select) await current.request("audio.select", routing);
      if (!valid()) throw new Error("FaceTime routing cancelled");
      const result = faceTimeRecord(await current.request("audio.devices"));
      if (!valid()) throw new Error("FaceTime routing cancelled");
      const devices = Array.isArray(result.devices) ? result.devices.map(faceTimeRecord) : [];
      for (const section of ["input", "output"] as const) {
        const selected = devices.filter((device) => device.section === section && device.selected === true);
        if (selected.length !== 1 || selected[0].name !== routing[section] || selected[0].enabled !== true) {
          throw new Error(`FaceTime ${section} selection did not verify by exact device name`);
        }
      }
    } catch (error) {
      throw new Error(`Open FaceTime, check its Video → Microphone / Output devices, then retry: ${asError(error).message}`);
    }
  }
  function enableAudio(session: OwnedCall) {
    if (!live(session) || !session.voice || !session.verified || session.id !== callId(observed)) return;
    if (session.requestedMedia && (observed.media === "audio" || observed.media === "video") && observed.media !== session.requestedMedia) {
      operationFailed(session, new Error(`FaceTime observed ${observed.media} differs from requested ${session.requestedMedia}; audio remains gated, check FaceTime manually, do not retry`));
      return;
    }
    if (session.audio) return;
    try {
      session.voice.setAudioEnabled(true);
      if (!live(session)) return;
      session.audio = true;
      publish("connected");
      // This belongs to the call, not a transport connection: reconnects can
      // create another voice handle but must never replay the introduction.
      if (live(session) && session.direction === "outgoing" && !session.introduced && session.voice) {
        session.introduced = true;
        try { session.voice.introduceOutgoingCall?.(session.purpose); } catch (error) { report(error); }
      }
    } catch (error) {
      cancelVoice(session);
      publish("failed", asError(error).message);
      report(error);
      void endOwned().catch(report);
    }
  }
  async function prepare(session: OwnedCall) {
    if (session.preparation) return session.preparation;
    const controller = session.controller;
    const signal = controller.signal;
    const pending = Promise.resolve().then(() => {
      if (!live(session)) throw new Error("FaceTime voice preparation cancelled");
      return options.prepareVoice(signal);
    }).then((voice) => {
      // prepareVoice's contract requires gates BEFORE negotiation; reinforce it here.
      try { voice.setAudioEnabled(false); }
      catch (error) { void stopVoice(voice); throw error; }
      if (!live(session) || session.controller !== controller) { void stopVoice(voice); throw new Error("FaceTime voice preparation cancelled"); }
      session.voice = voice;
      enableAudio(session);
    });
    // Cancellation settles callers promptly even if a broken provider ignores abort.
    // The pending continuation still gates/stops any late handle.
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new Error("FaceTime voice preparation cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    session.preparation = Promise.race([pending, cancelled]).finally(() => signal.removeEventListener("abort", abort));
    return session.preparation;
  }
  function newOwned(direction: OwnedCall["direction"], identity?: string, id?: string): OwnedCall {
    return { generation: randomUUID(), instance: instance!, id, identity, direction, controller: new AbortController(), answerSent: false,
      callSent: false, hangupSent: false, ending: false, verified: false, audio: false };
  }
  function operationFailed(session: OwnedCall, error: unknown, controller = session.controller) {
    if (owned !== session || !state.enabled || session.ending || controller !== session.controller || controller.signal.aborted) return;
    cancelVoice(session);
    // Keep an attempted mutation's ownership for lifecycle evidence/hangup, never retry it.
    if (session.id) blocked = `${session.instance}/${session.id}`;
    if (!session.callSent && !session.answerSent) owned = undefined;
    publish(!state.connected || !ready ? "unavailable" : active(observed) ? "busy" : "standby", asError(error).message);
    report(error);
  }
  function incoming(): Promise<unknown> {
    if (!state.enabled || !ready || !client) return Promise.reject(new Error("FaceTime mode is unavailable"));
    if (owned?.action && owned.id === callId(observed)) return owned.action;
    if (owned || observed.phase !== "incoming" || observed.allowed !== true || !callId(observed)) {
      return Promise.reject(new Error("No unowned, explicitly allowed incoming FaceTime call is ready"));
    }
    const session = newOwned("incoming", typeof observed.identity === "string" ? observed.identity : undefined, callId(observed));
    owned = session;
    publish("preparing");
    const current = client;
    const controller = session.controller;
    session.action = (async () => {
      await prepare(session);
      if (!live(session) || observed.phase !== "incoming" || observed.allowed !== true || callId(observed) !== session.id) throw new Error("Incoming FaceTime call changed during preparation");
      publish("answering");
      if (!live(session) || controller !== session.controller || callId(observed) !== session.id) throw new Error("FaceTime answer cancelled");
      session.answerSent = true;
      return current.request("answer");
    })().catch((error) => { operationFailed(session, error, controller); throw error; });
    return session.action;
  }
  function resume(session: OwnedCall) {
    if (session.retained) { publish("unconfirmed"); return; }
    if (session.ending) { publish("ending"); return; }
    if (session.controller.signal.aborted) {
      session.controller = new AbortController();
      session.preparation = undefined;
    }
    const controller = session.controller;
    publish("preparing");
    void prepare(session).then(() => { if (controller === session.controller) enableAudio(session); })
      .catch((error) => operationFailed(session, error, controller));
  }
  function disconnected(error: Error) {
    if (!state.enabled) return;
    ++connection;
    ready = false;
    state.connected = false;
    if (owned) {
      cancelVoice(owned);
      if (!owned.id || (!owned.callSent && !owned.answerSent)) forget();
    }
    publish("unavailable", error.message);
  }
  function snapshotReceived(value: FaceTimeSnapshot) {
    const snapshot = validateFaceTimeSnapshot(value);
    validatePolicy(snapshot, initialized || !options.configPath);
    if (snapshot.serviceInstanceId === instance && snapshot.seq < seq) throw new Error("FaceTime snapshot sequence regressed");
    const epoch = ++connection;
    ready = false;
    authorityChanged();
    instance = snapshot.serviceInstanceId;
    seq = snapshot.seq;
    observed = { ...snapshot.call };
    const callMedia = faceTimeRecord(snapshot.configuration).callMedia;
    supportsVideoCalls = Array.isArray(callMedia) && callMedia.includes("video");
    state.connected = true;
    if (!initialized) return;
    // Reconciliation never answers an incoming snapshot or adopts an unrelated call.
    if (owned && (owned.instance !== instance || owned.id !== callId(observed) || !active(observed))) forget();
    blocked = active(observed) ? `${instance}/${callId(observed)}` : undefined;
    if (owned) {
      if (observed.phase === "unconfirmed" || owned.retained) {
        observed = { ...observed, phase: "unconfirmed", verified: false };
        retain(owned);
      } else owned.verified = observed.phase === "connected" && observed.verified === true;
    }
    publish("reconciling");
    const current = client!;
    const valid = () => state.enabled && client === current && connection === epoch;
    void configureRouting(current, valid, false).then(() => {
      if (!valid()) return;
      ready = true;
      if (owned?.retained) publish("unconfirmed");
      else if (owned?.verified) resume(owned);
      else if (owned) publish(owned.ending ? "ending" : "waiting");
      else standby();
    }).catch((error) => { if (valid()) { publish("unavailable", asError(error).message); report(error); } });
  }
  function eventReceived(raw: FaceTimeRecord) {
    if (raw.protocolVersion !== 1 || raw.serviceInstanceId !== instance || !Number.isSafeInteger(raw.seq)) return;
    if ((raw.seq as number) <= seq) return;
    seq = raw.seq as number;
    const event = faceTimeSemanticEvent(raw);
    if (!event) return;
    const name = event.event;
    const id = callId(event);
    if (typeof name === "string" && name.startsWith("call.") && id) {
      const retained = name === "call.failed" && event.status === "retained";
      const terminal = name === "call.ended" || (name === "call.failed" && !retained);
      if (terminal) {
        const ownedTerminal = owned?.id === id || !!(owned && !owned.id && owned.callSent && !owned.retained);
        if (ownedTerminal || (owned?.retained && !owned.id && callId(observed) === id)) forget();
        if (callId(observed) === id) { observed = { phase: "idle" }; blocked = undefined; }
        if (ready) standby();
        if (ownedTerminal) safe(() => options.onCallEnded?.(event));
      } else {
        // New calls cancel every automatic action belonging to the previous one.
        if (owned?.id && owned.id !== id) forget();
        if (owned && !owned.id && (!owned.callSent || event.direction === "incoming")) forget();
        if (owned?.id === id && name === "call.connected" && owned.direction === "incoming" && !owned.answerSent) forget();
        if (owned?.id === id && name === "call.incoming" && event.allowed !== true) {
          blocked = `${instance}/${id}`;
          forget();
        }
        const same = callId(observed) === id;
        // A retained failure can precede the response. Close pending voice,
        // but only that response may establish the outgoing hangup target.
        // An unrelated event or snapshot must never authorize adoption.
        if (retained && owned && !owned.id && owned.callSent) retain(owned);
        const unconfirmed = retained || (same && observed.phase === "unconfirmed") || (owned?.id === id && owned.retained);
        if (retained) blocked = `${instance}/${id}`;
        if (unconfirmed && owned?.id === id) retain(owned);
        const phase = unconfirmed ? "unconfirmed" : name === "call.incoming" ? "incoming" : name === "call.connected" ? "connected"
          : name === "call.dialing" ? "dialing" : same ? observed.phase : "unknown";
        observed = { ...(same ? observed : {}), ...event, phase,
          ...(name === "call.incoming" ? { allowed: event.allowed === true } : {}),
          ...(unconfirmed ? { verified: false } : {}) };
        if (unconfirmed) {
          if (ready) publish("unconfirmed");
        } else if (owned?.id === id && name === "call.connected" && event.verified === true) {
          owned.verified = true;
          if (ready) {
            if (owned.controller.signal.aborted) resume(owned);
            else enableAudio(owned);
          }
        } else if (ready && !owned && name === "call.incoming" && event.allowed === true && blocked !== `${instance}/${id}`) {
          void incoming().catch(() => {}); // operationFailed already reports owned failures.
        } else if (ready && !owned) standby();
      }
    }
    authorityChanged();
    safe(() => options.onEvent?.(event));
  }
  async function endOwned(): Promise<unknown> {
    const session = owned;
    if (!session) return undefined;
    if (session.ending) return session.endingRequest;
    session.ending = true;
    cancelVoice(session);
    if (!session.callSent && !session.answerSent) {
      forget();
      standby();
      return undefined;
    }
    const hangupWhenIdentified = () => {
      // Never hang up a replacement or a call whose ownership is still unknown.
      if (owned !== session || session.hangupSent || !state.connected || !client || instance !== session.instance
        || !session.id || session.id !== callId(observed) || !active(observed)) return undefined;
      session.hangupSent = true;
      // Deliberately no expectedCallId: the service does not implement that safeguard.
      return client.request("hangup");
    };
    // Keep teardown/lease ownership until an in-flight submission resolves (or
    // its transport timeout rejects). Its response can identify the owned call
    // even after audio has been cancelled. Never replay the submission itself.
    session.endingRequest = !session.id && session.callRequest
      ? session.callRequest.then(hangupWhenIdentified)
      : Promise.resolve().then(hangupWhenIdentified);
    publish(session.retained ? "unconfirmed" : "ending");
    return session.endingRequest;
  }
  async function sharingRequest(command: "screen.share" | "screen.stop", display?: string): Promise<unknown> {
    const session = owned;
    const current = client;
    const epoch = connection;
    const controller = session?.controller;
    const valid = () => !!session && client === current && connection === epoch && session.controller === controller
      && state.connected && state.phase === "connected" && live(session) && session.verified && session.audio && !!session.voice
      && !!session.id && session.id === callId(observed) && observed.phase === "connected" && observed.verified === true;
    if (!session || !current || !valid()) throw new Error("FaceTime screen sharing requires an owned, verified connected call with audio enabled");
    // One mutation, no probes/retries or local sharing cache. The service verifies
    // the entire-screen picker and Allow Control off, guarded by this call ID.
    const result = await current.request(command, { ...(display !== undefined ? { display } : {}), expectedCallId: session.id });
    if (!valid()) throw new Error("FaceTime call changed during screen sharing; outcome unknown, do not retry automatically");
    const evidence = faceTimeRecord(result);
    if (evidence.verified !== true || evidence.active !== (command === "screen.share")
      || (command === "screen.share" && (evidence.display !== display || evidence.remoteControl !== false))) {
      throw new Error("FaceTime sharing state did not verify; check FaceTime manually, do not retry automatically");
    }
    return result;
  }
  function disable(): Promise<void> {
    if (disabling) return disabling;
    if (!state.enabled && !client && !release) return Promise.resolve();
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    // Install the guard before callbacks (including stopVoice/onStatus) can reenter.
    disabling = done;
    ++run;
    ++connection;
    state.enabled = false;
    ready = false;
    const current = client;
    const lease = release;
    release = undefined;
    // endOwned works while disabled and gates audio synchronously before any await.
    const ending = endOwned().catch(report);
    void (async () => {
      try { await ending; }
      finally {
        forget();
        current?.close();
        if (client === current) client = undefined;
        initialized = false;
        state.connected = false;
        instance = undefined;
        observed = { phase: "idle" };
        blocked = undefined;
        seq = -1;
        await Promise.all([...stopping]);
        lease?.();
        publish("disabled");
      }
    })().then(resolve, reject).finally(() => { if (disabling === done) disabling = undefined; });
    return done;
  }
  function enable(): Promise<void> {
    if (disabling) return disabling.then(enable);
    if (enabling) return enabling;
    if (state.enabled) return Promise.resolve();
    const generation = ++run;
    state.enabled = true;
    publish("enabling");
    enabling = (async () => {
      try {
        if (run !== generation || !state.enabled) throw new Error("FaceTime enable cancelled");
        release = (options.acquireLease ?? acquireFaceTimeLease)(socketPath);
        const callbacks: FaceTimeClientCallbacks = {
          onSnapshot(snapshot) {
            if (run !== generation || !state.enabled) return;
            try { snapshotReceived(snapshot); }
            catch (error) { disconnected(asError(error)); report(error); }
          },
          onEvent(event) { if (run === generation && state.enabled) eventReceived(event); },
          onDisconnect(error) { if (run === generation) disconnected(error); },
        };
        const current = options.createClient?.(callbacks) ?? createFaceTimeClient({ ...options.clientOptions, ...callbacks, socketPath });
        client = current;
        const snapshot = validateFaceTimeSnapshot(await current.connect());
        validatePolicy(snapshot, !options.configPath);
        if (run !== generation || !state.enabled) throw new Error("FaceTime enable cancelled");
        if (active(snapshot.call) || active(observed)) throw new Error("FaceTime already has an active call; end it before enabling Pi FaceTime mode (no takeover)");
        if (options.configPath) {
          // The app applies the managed visible Pi Talk endpoint in both
          // directions. This idle-only reload also refreshes allowlists/timeouts.
          const refreshed = validateFaceTimeSnapshot(await current.request("config.reload"));
          if (run !== generation || !state.enabled) throw new Error("FaceTime enable cancelled");
          if (refreshed.serviceInstanceId !== instance) throw new Error("FaceTime service changed during shared config reload");
          validatePolicy(refreshed);
          if (active(refreshed.call) || active(observed)) throw new Error("FaceTime call appeared during config reload; refusing takeover");
          snapshotReceived(refreshed);
        }
        const epoch = connection;
        await configureRouting(current, () => run === generation && state.enabled && state.connected && connection === epoch, !options.configPath);
        if (run !== generation || !state.enabled || connection !== epoch) throw new Error("FaceTime enable cancelled");
        // A new call arriving during setup is not a readiness-authorized incoming event.
        if (active(observed)) throw new Error("FaceTime call appeared during setup; end it and enable again");
        ready = true;
        initialized = true;
        standby();
      } catch (error) {
        if (run === generation) { report(error); await disable(); }
        throw error;
      }
    })();
    const result = enabling;
    void result.finally(() => { if (enabling === result) enabling = undefined; }).catch(() => {});
    return result;
  }
  return {
    enable, disable,
    status: () => ({ ...state }),
    presentationAuthority,
    answer: incoming,
    async call(purpose, requestedMedia) {
      const media = faceTimeCallMedia(requestedMedia);
      const to = options.recipient;
      if (typeof to !== "string" || !to.trim() || Buffer.byteLength(to) > 1024) throw new Error("Invalid configured FaceTime owner recipient");
      validateFaceTimeCallPurpose(purpose);
      if (!state.enabled || !ready || !client) throw new Error("FaceTime mode is unavailable");
      // Older protocol-1 services ignore unknown arguments and dial audio.
      // Never submit video until this service explicitly advertises support.
      if (media === "video" && !supportsVideoCalls) throw new Error("FaceTime video requires an updated native bridge advertising video callMedia support; no call submitted");
      if (owned || active(observed)) throw new Error("A FaceTime call is already active; no takeover");
      const current = client;
      const session = newOwned("outgoing", to);
      session.purpose = purpose?.trim();
      session.requestedMedia = media;
      const controller = session.controller;
      owned = session;
      publish("preparing");
      try {
        await prepare(session);
        if (!live(session) || active(observed)) throw new Error("FaceTime call changed during preparation");
        publish("dialing");
        if (!live(session) || active(observed)) throw new Error("FaceTime outgoing call cancelled");
        session.callRequest = Promise.resolve().then(() => {
          if (!live(session)) throw new Error("FaceTime outgoing call cancelled before submission");
          session.callSent = true;
          return current.request("call", { to, media });
        }).then((result) => {
          if (owned !== session || client !== current || instance !== session.instance) throw new Error("FaceTime outgoing call cancelled; no longer owned, outcome unknown");
          const id = callId(faceTimeRecord(result));
          if (!id) throw new Error("FaceTime call response omitted callId; outcome unknown, not retried");
          if (active(observed) && callId(observed) !== id) { forget(); standby(); throw new Error("FaceTime call changed; refusing takeover"); }
          session.id = id;
          if (faceTimeRecord(result).status === "retained") {
            observed = { ...observed, phase: "unconfirmed", callId: id, verified: false };
            blocked = `${instance}/${id}`;
            retain(session);
            publish("unconfirmed");
          }
          if (!active(observed)) observed = { phase: "starting", callId: id, identity: to, direction: "outgoing" };
          session.verified = !session.retained && observed.phase === "connected" && observed.verified === true;
          // Submission/URL acceptance proves neither connection nor active video.
          return { ...faceTimeRecord(result), requestedMedia: media };
        });
        const result = await session.callRequest;
        if (session.retained) throw new Error("FaceTime call is unconfirmed; review UI manually, do not retry");
        if (!live(session)) throw new Error("FaceTime outgoing call cancelled; outcome unknown");
        enableAudio(session);
        return result;
      } catch (error) { operationFailed(session, error, controller); throw error; }
    },
    hangup: endOwned,
    async shareScreen(display) {
      if (typeof display !== "string" || !display.trim() || Buffer.from(display).toString("utf8") !== display || /[\x00-\x1f\x7f-\x9f]/u.test(display)) {
        throw new Error("FaceTime sharing requires an exact, nonempty display name for an entire screen");
      }
      return sharingRequest("screen.share", display);
    },
    stopSharing: () => sharingRequest("screen.stop"),
    async voiceEnded() {
      try { await endOwned(); }
      catch (error) { report(error); }
      // Await actual voice cleanup, but remain ending until service lifecycle evidence.
      await Promise.all([...stopping]);
    },
  };
}

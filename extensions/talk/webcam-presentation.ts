import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { createPresentationAssetCache, PresentationAssetError } from './webcam/src/shared/presentation-assets.ts';
import { PRESENTATION_ID, PRESENTATION_MAX_TEXT_CHARS, PRESENTATION_MAX_TITLE_BYTES, presentationText, type Presentation, type DisplayAuthority } from './webcam/src/shared/presentation-protocol.ts';

export interface PresentationAuthority {
  /** Private authoritative identities; NEVER forwarded to the renderer or tool result. */
  sessionKey: string;
  callKey: string;
  /** Opaque visual voice-run ID already used by Talk, NOT a provider identifier. */
  runId: string;
  owned: boolean;
  verified: boolean;
  connected: boolean;
}
export interface PresentationHost {
  /** Must read actual current owned FaceTime call/voice state, not event-bus display state. */
  currentCall(): PresentationAuthority | undefined;
  /** Private actual publisher authority. Absent on legacy injected hosts: webcam fails closed. */
  currentPublisher?(): DisplayAuthority | undefined;
  sharingActive(): boolean;
  /** Readiness of the opted-in HUD publisher, not merely a callable publish function. */
  publisherReady(): boolean;
  /** Same actual socket used by the publisher (including custom agentDir/socket). */
  socketPath(): string;
  /** Synchronous full replacement; null removes presentation immediately. No history retention. */
  publish(value: Presentation | null): void;
}
export interface PresentationInput { action: 'show' | 'clear'; text?: string; imagePath?: string; title?: string }
export interface PresentationResult { action: 'show' | 'clear'; active: boolean; hasText: boolean; hasImage: boolean }

/** No IO at construction, no timers, no listeners, no launch/call/audio/network controls.
 * Host MUST call sync() synchronously on EVERY authority/sharing/publisher edge,
 * including short disconnects between HUD heartbeats; reset() before session changes. */
export function createCallPresentationController(host: PresentationHost) {
  let authorityKey = '', socket = '', scopeId = '', disposed = false;
  let current: Presentation | null = null;
  let strictKey = '';
  let cache: ReturnType<typeof createPresentationAssetCache> | undefined;
  function strictCall(): PresentationAuthority | undefined {
    const call = host.currentCall();
    return call?.owned && call.verified && call.connected && call.sessionKey && call.callKey
      && PRESENTATION_ID.test(call.runId) ? call : undefined;
  }
  const callKey = (call: PresentationAuthority) => JSON.stringify([call.sessionKey, call.callKey, call.runId]);
  function authority(): { sessionKey: string; displayScopeId?: string; socket: string; key: string } | undefined {
    if (disposed || !host.sharingActive() || !host.publisherReady()) return undefined;
    const path = host.socketPath();
    if (host.currentPublisher) {
      const publisher = host.currentPublisher();
      if (!publisher?.sessionKey || !PRESENTATION_ID.test(publisher.scopeId)) return undefined;
      return { sessionKey: publisher.sessionKey, displayScopeId: publisher.scopeId, socket: path,
        key: JSON.stringify([publisher.sessionKey, publisher.scopeId, path]) };
    }
    // Compatibility for strict-call-only injected hosts. Never authorizes the new tool.
    const call = strictCall();
    return call ? { sessionKey: call.sessionKey, socket: path, key: JSON.stringify([callKey(call), path]) } : undefined;
  }
  function reset(): void {
    const hadPresentation = current !== null;
    current = null; authorityKey = scopeId = strictKey = '';
    // Clear eagerly once, not on every inactive render/sync (which would flood
    // the bounded socket and disconnect healthy clients through backpressure).
    try { if (hadPresentation) host.publish(null); } finally { cache?.clear(); }
  }
  function sync(): void {
    const next = authority();
    const call = current?.version === 1 ? strictCall() : undefined;
    if (!next || next.key !== authorityKey || (current?.version === 1 && (!call || callKey(call) !== strictKey))) {
      reset();
      if (next) {
        // Never discard ownership records for failed cleanup when retargeting.
        if (cache && socket !== next.socket && cache.count() !== 0)
          throw new Error('Presentation cache cleanup must complete before retargeting');
        if (!cache || socket !== next.socket) { cache = createPresentationAssetCache(next.socket); socket = next.socket; }
        authorityKey = next.key; scopeId = randomUUID();
      }
    }
  }
  function requireAuthority(sessionKey: string | undefined, webcam: boolean): NonNullable<ReturnType<typeof authority>> {
    sync();
    if (!host.sharingActive()) throw new Error('Webcam sharing is off');
    const publisher = webcam ? host.currentPublisher?.() : undefined;
    if (publisher && sessionKey !== publisher.sessionKey)
      throw new Error('Webcam publisher belongs to a different Pi session');
    const next = authority();
    if (!next || next.key !== authorityKey || (webcam && !next.displayScopeId))
      throw new Error('Webcam publisher unavailable; an updated session-owned ready HUD publisher is required');
    if ((webcam && !sessionKey) || (sessionKey !== undefined && sessionKey !== next.sessionKey))
      throw new Error('Webcam publisher belongs to a different Pi session');
    if (!webcam) {
      const call = strictCall();
      if (!call || call.sessionKey !== next.sessionKey)
        throw new Error('Presentation requires an owned, verified connected call');
    }
    return next;
  }
  function executePresentation(input: PresentationInput, sessionKey?: string, signal?: AbortSignal, webcam = false): PresentationResult {
    if (signal?.aborted) throw new Error('Presentation cancelled');
    const start = requireAuthority(sessionKey, webcam);
    const startCall = webcam ? undefined : strictCall()!;
    if (!input || !['show', 'clear'].includes(input.action)) throw new Error('action must be show or clear');
    if (input.action === 'clear') {
      if (input.text !== undefined || input.imagePath !== undefined || input.title !== undefined)
        throw new Error('clear does not accept text, imagePath or title');
      reset();
      return { action: 'clear', active: false, hasText: false, hasImage: false };
    }
    const text = input.text === undefined ? undefined : presentationText(input.text);
    const title = input.title === undefined ? undefined : presentationText(input.title, true);
    if (input.imagePath !== undefined && (typeof input.imagePath !== 'string' || !input.imagePath.trim() || input.imagePath.length > 4096))
      throw new Error('imagePath must be a nonempty absolute local image path, at most 4096 characters');
    if (!text && !input.imagePath) throw new Error('show requires nonempty text and/or imagePath');
    const sourceNames = input.imagePath ? [input.imagePath,
      ...(isAbsolute(input.imagePath) ? [resolve(input.imagePath)] : [])] : [];
    if (sourceNames.some(path => text?.includes(path) || title?.includes(path)))
      throw new Error('Do not include the original image path in visible text or title');
    let image: Presentation['image'];
    try {
      if (input.imagePath) image = cache!.put(input.imagePath);
      const finish = authority();
      const finishCall = webcam ? undefined : strictCall();
      if (signal?.aborted || !finish || finish.key !== start.key
        || (!webcam && (!finishCall || callKey(finishCall) !== callKey(startCall!)))) {
        sync();
        throw new Error('Presentation cancelled because its authority or sharing state changed');
      }
      const next: Presentation = { ...(webcam ? { version: 2 as const, scopeId: finish.displayScopeId! }
        : { version: 1 as const, scopeId, runId: finishCall!.runId }), id: randomUUID(),
        ...(title ? { title } : {}), ...(text ? { text } : {}), ...(image ? { image } : {}) };
      const previous = current;
      // Never return source path/text/image bytes as tool details or append history entries.
      host.publish(structuredClone(next));
      current = next;
      strictKey = finishCall ? callKey(finishCall) : '';
      if (previous?.image) cache!.remove(previous.image.assetId);
      return { action: 'show', active: true, hasText: !!text, hasImage: !!image };
    } catch (error) {
      if (image) cache?.remove(image.assetId);
      if (error instanceof PresentationAssetError) throw error;
      // Filesystem exceptions include source paths: never forward their raw messages.
      if (error && typeof error === 'object' && 'code' in error) throw new Error('Could not safely read or cache the local image; use a regular PNG/JPEG file and private cache directories without symlinks');
      throw error;
    }
  }
  return {
    sync, reset,
    execute: (input: PresentationInput, sessionKey?: string, signal?: AbortSignal) => executePresentation(input, sessionKey, signal),
    executeWebcam: (input: PresentationInput, sessionKey: string, signal?: AbortSignal) => executePresentation(input, sessionKey, signal, true),
    /** A call lifecycle edge must never revoke a standalone webcam panel. */
    clearCall() { if (current?.version === 1) reset(); },
    /** Detached metadata only. Host still must gate every published snapshot by current authority. */
    read(): Presentation | null { sync(); return current ? structuredClone(current) : null; },
    dispose() { if (disposed) return; disposed = true; reset(); },
  };
}
export type CallPresentationController = ReturnType<typeof createCallPresentationController>;

/** Explicit registration API, not a discovered extension entry point. The tool can
 * be invoked autonomously during a call; this authorization is presentation-only. */
export function registerCallPresentationTool(pi: Pick<ExtensionAPI, 'registerTool'>, controller: CallPresentationController): void {
  registerPresentationTool(pi, controller, false);
}
export function registerWebcamPresentationTool(pi: Pick<ExtensionAPI, 'registerTool'>, controller: CallPresentationController): void {
  registerPresentationTool(pi, controller, true);
}
function registerPresentationTool(pi: Pick<ExtensionAPI, 'registerTool'>, controller: CallPresentationController, webcam: boolean): void {
  const name = webcam ? 'present_to_webcam' : 'present_to_call';
  pi.registerTool({
    name, label: webcam ? 'Present to webcam' : 'Present to call', executionMode: 'sequential',
    description: webcam
      ? 'Show or clear an explicit public presentation in this Pi session’s already active, opted-in webcam/HUD feed. No Talk voice or FaceTime call is required. May be invoked autonomously to explain something. Persists until replaced, cleared, sharing off, session/branch change, publisher disconnect/stale or app close; ending a call alone does not clear it. show replaces the whole panel: plain text (1200 characters / 2400 UTF-8 bytes), optional short title, and/or an absolute regular local PNG/JPEG imagePath (8 MiB, 4096px edge, 8 megapixels maximum). No URLs, symlinks, credentials, hidden reasoning, auth, arbitrary history or nonimage files. Only intended public camera content. Publishes even if no renderer is connected; does not guarantee anyone sees it. Never enables sharing, launches apps, starts calls, controls audio or makes provider requests. clear takes no content fields.'
      : 'Show or clear an explicit presentation in the current owned, verified connected call camera view. You may invoke this on your own during that call to help explain something. Persists until replaced, cleared or the call ends. show replaces the whole panel: plain readable public text (up to 1200 characters / 2400 UTF-8 bytes), optional short title, and/or an absolute local PNG/JPEG imagePath (8 MiB, 4096px edge, 8 megapixels maximum). No remote URLs, credentials, hidden reasoning, auth, arbitrary history or nonimage files. Only choose content intended for the user to see on camera. Never start a call, launch an app, enable sharing, control audio or make provider requests. clear takes no content fields.',
    // Additive runtime hint, like the existing FaceTime tools (older SDK omits it).
    ...{ annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
    parameters: Type.Object({
      action: Type.Union([Type.Literal('show'), Type.Literal('clear')]),
      text: Type.Optional(Type.String({ maxLength: PRESENTATION_MAX_TEXT_CHARS, description: 'Explicit user-visible plain paragraphs, bullet markers or headings. Never hidden reasoning or auth.' })),
      imagePath: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: 'Absolute regular local PNG/JPEG path. Never URLs, credentials or symlinks. Original path is not sent to camera/HUD.' })),
      title: Type.Optional(Type.String({ maxLength: PRESENTATION_MAX_TITLE_BYTES, description: 'Optional modest one-line public title (96 UTF-8 bytes).' })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const sessionKey = ctx.sessionManager.getSessionId();
      const result = webcam ? controller.executeWebcam(params, sessionKey, signal) : controller.execute(params, sessionKey, signal);
      return { content: [{ type: 'text', text: result.active
        ? (webcam ? 'Presentation published to active webcam feed' : 'Presentation shown in the current call.')
        : 'Presentation cleared.' }], details: result };
    },
    // The default tool renderer would print imagePath. Keep even expanded UI path-free.
    renderCall(args, theme) { return new Text(theme.fg('toolTitle', `${name} ${args.action === 'clear' ? 'clear' : 'show'}`), 0, 0); },
  });
}

import { LIVE_HUD_MAX_BYTES, LIVE_HUD_MAX_EVENTS, LIVE_HUD_TOOL_NAME,
  LIVE_HUD_MAX_TRANSCRIPT_BLOCKS, LIVE_HUD_MAX_TRANSCRIPT_TEXT, LIVE_HUD_MAX_TRANSCRIPT_BYTES,
  LIVE_CAPTION_MAX_TEXT, LIVE_CAPTION_FINAL_MS, LIVE_CAPTION_PARTIAL_MS, captionCallActive,
  type LiveCaptions, type TalkVisualState, type LiveHudEvent, type LiveHudSnapshot } from './live-protocol.ts';

import { parsePresentation, presentationText } from './presentation-protocol.ts';

type Parser = (value: unknown) => unknown;
const bad = (): never => { throw new Error('Invalid HUD snapshot'); };
const number = (max = Number.MAX_SAFE_INTEGER, integer = false): Parser => value =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max
    && (!integer || Number.isSafeInteger(value)) ? value : bad();
const count = number(Number.MAX_SAFE_INTEGER, true);
const percent = number(100);
const string = (max: number, nonempty = false): Parser => value => typeof value === 'string' && (!nonempty || value.length > 0) && value.length <= max
  && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value) ? value : bad();
const boolean: Parser = value => typeof value === 'boolean' ? value : bad();
const choice = (...allowed: unknown[]): Parser => value => allowed.includes(value) ? value : bad();
const nullable = (parse: Parser): Parser => value => value === null ? null : parse(value);
const array = (parse: Parser, max: number): Parser => value => Array.isArray(value) && value.length <= max ? Array.from(value, parse) : bad();
function object(required: Record<string, Parser>, optional: Record<string, Parser> = {}): Parser {
  return value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return bad();
    const fields = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(fields).some(key => typeof key !== 'string' || (!Object.hasOwn(required, key) && !Object.hasOwn(optional, key)))) return bad();
    const result: Record<string, unknown> = {};
    for (const [key, parse] of Object.entries({ ...required, ...optional })) {
      const field = fields[key];
      if (!field) { if (Object.hasOwn(required, key)) return bad(); continue; }
      if (!Object.hasOwn(field, 'value') || !field.enumerable) return bad();
      result[key] = parse(field.value);
    }
    return result;
  };
}
const opaqueId: Parser = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value) ? value : bad();
const toolName: Parser = value => typeof value === 'string' && LIVE_HUD_TOOL_NAME.test(value) ? value : bad();
const encoder = new TextEncoder();
const transcriptId: Parser = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : bad();
const transcriptText: Parser = value => typeof value === 'string' && value.trim().length > 0
  && value.length <= LIVE_HUD_MAX_TRANSCRIPT_TEXT
  // Match the producer's format-control policy; Unicode mode preserves valid surrogate pairs.
  && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\p{Cf}\uD800-\uDFFF]/u.test(value)
  && encoder.encode(value).byteLength <= LIVE_HUD_MAX_TRANSCRIPT_TEXT ? value : bad();
const captionText: Parser = value => {
  const parsed = transcriptText(value) as string;
  return encoder.encode(parsed).byteLength <= LIVE_CAPTION_MAX_TEXT ? parsed : bad();
};
const captionsSchema = object({ runId: string(128, true), lines: array(object({
  id: opaqueId, speaker: choice('user', 'assistant'), text: captionText, final: boolean,
  updatedAt: count, expiresAt: count,
}), 2) });
function validCaptions(captions: LiveCaptions, talk: TalkVisualState, at: number): boolean {
  return captionCallActive(talk) && captions.runId === talk.runId
    && new Set(captions.lines.map(line => line.speaker)).size === captions.lines.length
    && new Set(captions.lines.map(line => line.id)).size === captions.lines.length
    && captions.lines.every(line => line.updatedAt <= at && line.expiresAt > line.updatedAt
      && line.expiresAt - line.updatedAt <= (line.final ? LIVE_CAPTION_FINAL_MS : LIVE_CAPTION_PARTIAL_MS));
}
/** Shared exact allowlist for the local caption event and the socket contract. */
export function parseLiveCaptions(value: unknown, talk: TalkVisualState, at: number): LiveCaptions | null {
  try {
    const parsed = captionsSchema(value) as LiveCaptions;
    return validCaptions(parsed, talk, at) ? parsed : null;
  } catch { return null; }
}
const transcriptSchema = object({ id: transcriptId, role: choice('user', 'assistant', 'tool', 'custom'), text: transcriptText });
const eventSchema = object({
  id: opaqueId, timestamp: number(8_640_000_000_000_000, true),
  role: choice('user', 'assistant', 'toolResult', 'system'),
  kind: choice('user_turn', 'assistant_finished', 'tool', 'run', 'compaction'),
  status: choice('received', 'finished', 'started', 'completed', 'failed', 'settled', 'aborted', 'recorded'),
}, { toolName });
function validEvent(event: LiveHudEvent): boolean {
  if (event.kind !== 'tool' && event.toolName !== undefined) return false;
  switch (event.kind) {
    case 'user_turn': return event.role === 'user' && event.status === 'received';
    case 'assistant_finished': return event.role === 'assistant' && event.status === 'finished';
    case 'tool': return event.role === 'toolResult' && ['started', 'completed', 'failed', 'recorded'].includes(event.status);
    case 'run': return event.role === 'system' && ['started', 'settled', 'aborted'].includes(event.status);
    case 'compaction': return event.role === 'system' && ['started', 'completed', 'failed', 'aborted'].includes(event.status);
  }
}
const presentationContent = {
  title: (value: unknown) => presentationText(value, true), text: (value: unknown) => presentationText(value),
  image: object({ assetId: string(32, true), mime: choice('image/png', 'image/jpeg'),
    bytes: count, width: count, height: count }),
};
const callPresentationSchema = object({ version: choice(1), scopeId: transcriptId, runId: transcriptId, id: transcriptId }, presentationContent);
const webcamPresentationSchema = object({ version: choice(2), scopeId: transcriptId, id: transcriptId }, presentationContent);
const presentationSchema: Parser = value => {
  try { return webcamPresentationSchema(value); } catch { return callPresentationSchema(value); }
};
const schema = object({
  version: choice(1), streamId: string(128, true), sessionId: string(128, true), sequence: count, timestamp: number(),
  session: object({ provider: string(128), model: string(256), status: choice('idle', 'thinking', 'running'), startedAt: number(), elapsedMs: number() }),
  context: object({ tokens: nullable(number()), contextWindow: nullable(number()), percent: nullable(percent) }, { tokensPerSecond: number(1_000_000) }),
  agents: array(object({ id: count, label: string(128), task: string(1024),
    status: choice('queued', 'starting', 'thinking', 'running', 'completed', 'failed', 'aborted'), contextTokens: nullable(number()) },
  { model: string(256), startedAt: number(), endedAt: number(), contextWindow: number(), tokensPerSecond: number(1_000_000) }), 64),
  todos: array(object({ id: count, text: string(1024), completed: boolean }, { completedAt: number() }), 256),
  usage: object({ status: choice('inactive', 'loading', 'error', 'ready') }, {
    weekly: object({ remainingPercent: nullable(percent), usedPercent: nullable(percent) }, { resetAt: number() }), updatedAt: number(),
  }),
  talk: object({ phase: choice('idle', 'standby', 'preparing', 'summarizing', 'starting-native', 'creating-offer', 'connecting-voice', 'connecting-audio', 'ready', 'connected', 'stopping', 'error'),
    mode: choice('physical', 'virtual', 'facetime', 'inactive'), voiceReady: boolean, audioEnabled: boolean }, { elapsedMs: number(), runId: string(128, true) }),
}, {
  // Additive v1 evolution: older bridges remain usable, with honestly empty activity.
  branchId: opaqueId, events: array(eventSchema, LIVE_HUD_MAX_EVENTS),
  transcript: array(transcriptSchema, LIVE_HUD_MAX_TRANSCRIPT_BLOCKS),
  captions: captionsSchema,
  presentation: presentationSchema,
  displayScopeId: transcriptId,
  todoCounts: object({ total: count, pending: count, completed: count }),
});

/** Exact allowlist, bounded strings/arrays/numbers, fresh data-only objects. Never returns input objects. */
export function parseLiveHudSnapshot(value: unknown): LiveHudSnapshot | null {
  try {
    const parsed = schema(value) as LiveHudSnapshot;
    parsed.events ??= [];
    if (parsed.captions && !validCaptions(parsed.captions, parsed.talk, parsed.timestamp)) return null;
    if (parsed.presentation) {
      const presentation = parsePresentation(parsed.presentation, {
        displayScopeId: parsed.branchId ? parsed.displayScopeId : undefined,
        callRunId: captionCallActive(parsed.talk) ? parsed.talk.runId : undefined,
      });
      if (!presentation) return null;
      parsed.presentation = presentation;
    }
    // A legacy publisher has no branch epoch; nonempty activity needs a scope.
    parsed.branchId ??= 'legacy';
    if ((parsed.events.length || parsed.transcript?.length) && parsed.branchId === 'legacy') return null;
    if (parsed.transcript && (new Set(parsed.transcript.map(block => block.id)).size !== parsed.transcript.length
      || parsed.transcript.reduce((bytes, block) => bytes + encoder.encode(block.text).byteLength, 0) > LIVE_HUD_MAX_TRANSCRIPT_BYTES)) return null;
    if (new Set(parsed.events.map(event => event.id)).size !== parsed.events.length
      || parsed.events.some((event, index) => !validEvent(event) || event.timestamp > parsed.timestamp
        || (index > 0 && event.timestamp < parsed.events[index - 1]!.timestamp))) return null;
    if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > LIVE_HUD_MAX_BYTES) return null;
    if (new Set(parsed.agents.map(a => a.id)).size !== parsed.agents.length
      || new Set(parsed.todos.map(t => t.id)).size !== parsed.todos.length) return null;
    if (parsed.todoCounts) {
      const { total, pending, completed } = parsed.todoCounts;
      const shownCompleted = parsed.todos.filter(todo => todo.completed).length;
      if (total !== pending + completed || total < parsed.todos.length
        || completed < shownCompleted || pending < parsed.todos.length - shownCompleted) return null;
    }
    return parsed;
  } catch { return null; }
}

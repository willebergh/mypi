import { randomUUID } from "node:crypto";
import { types } from "node:util";
import type { ExtensionAPI, ExtensionContext, SessionEntry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { LIVE_HUD_MAX_TRANSCRIPT_BLOCKS, LIVE_HUD_MAX_TRANSCRIPT_BYTES, LIVE_HUD_MAX_TRANSCRIPT_TEXT, type LiveHudTranscriptBlock } from "./webcam/src/shared/live-protocol.ts";

/** Clip by UTF-8 bytes, never through a code point. */
function clip(text: string, budget: number): string {
  let bytes = 0, output = "";
  for (const point of text) {
    bytes += Buffer.byteLength(point);
    if (bytes > budget) break;
    output += point;
  }
  return output;
}

/** Newest UTF-8 suffix, without splitting a surrogate pair/code point. */
function clipTail(text: string, budget: number): string {
  let bytes = 0, start = text.length;
  while (start > 0) {
    let index = start - 1;
    const unit = text.charCodeAt(index);
    if (unit >= 0xdc00 && unit <= 0xdfff && index > 0) {
      const high = text.charCodeAt(index - 1);
      if (high >= 0xd800 && high <= 0xdbff) index--;
    }
    const size = Buffer.byteLength(text.slice(index, start));
    if (bytes + size > budget) break;
    bytes += size;
    start = index;
  }
  return text.slice(start);
}

/** Presentation only. Never consult credentials, stringify objects, or retain
 * unsanitized text. Redaction is deliberately best-effort, not a secret detector. */
export function sanitizeTranscriptText(value: unknown, budget = LIVE_HUD_MAX_TRANSCRIPT_TEXT, edge: "head" | "tail" = "tail"): string {
  if (typeof value !== "string") return "";
  const text = value
    // OSC (including hyperlinks/iTerm images), DCS/sixel, APC/kitty images,
    // SOS and PM. An unterminated string consumes the remainder, not its payload.
    .replace(/(?:\x1b\]|\u009d)[\s\S]*?(?:\x07|\x1b\\|\u009c|$)/g, "")
    .replace(/(?:\x1b[P_X^]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\x1b\\|\u009c|$)/g, "")
    .replace(/(?:\x1b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/(?:\x1b\[|\u009b)[^\n]*/g, "")
    .replace(/\x1b[ -/]*[0-~]/g, "")
    .replace(/\r\n?/g, "\n").replace(/[\u2028\u2029]/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\p{Cf}\p{Cs}]/gu, "")
    .replace(/-----BEGIN (?:[A-Z0-9 ]* )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9 ]* )?PRIVATE KEY-----|$)/g, "[redacted private key]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/._~=-]+/gi, "[redacted authorization]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{12,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/g, "[redacted credential]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted token]")
    .replace(/((?:["']?\b(?:[A-Z0-9_]*(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret|credential|authorization)|token)\b["']?)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/^\n+|\n+$/g, "");
  if (!text.trim()) return "";
  const clipped = (edge === "head" ? clip : clipTail)(text, budget);
  return clipped.trim() ? clipped : "";
}

type Renderers = Pick<ToolDefinition, "renderShell" | "renderCall" | "renderResult">;
type Resolver = (name: string, next: () => Renderers | undefined) => Renderers | undefined;
type CallRenderer = NonNullable<Renderers["renderCall"]>;
type RenderContext = Parameters<CallRenderer>[2];
type Component = ReturnType<CallRenderer>;
type Role = LiveHudTranscriptBlock["role"];
interface Row {
  key: string;
  block: LiveHudTranscriptBlock;
  stamp?: number;
  slot?: number;
  live?: boolean;
  toolId?: string;
  call?: string;
  result?: string;
}
interface Capture { epoch: number; toolId: string; slot: "call" | "result"; compact: boolean }
interface Group { key: string; role: Role; stamp?: number }
// Reject proxies before even asking for a descriptor: their traps are executable.
const object = (value: unknown): value is object => !!value && typeof value === "object" && !types.isProxy(value);
const record = (value: unknown): value is Record<string, unknown> => object(value) && !Array.isArray(value);
const array = (value: unknown): value is unknown[] => object(value) && Array.isArray(value);
function data(value: unknown, key: PropertyKey): unknown {
  if (!object(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch { return undefined; }
}
function textParts(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!array(content)) return undefined;
  const texts: string[] = [];
  for (let slot = 0; slot < content.length; slot++) {
    const part = data(content, slot);
    if (data(part, "type") !== "text") continue;
    const text = data(part, "text");
    if (typeof text !== "string") return undefined;
    texts.push(text);
  }
  return texts.join("\n");
}
const timestamp = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Observers hold only bounded sanitized presentation text. Lifecycle registration
 * itself is inert; only a successful explicit bridge.start enables collection. */
export function createWebcamTranscript(pi: ExtensionAPI) {
  let enabled = false;
  let epoch = 0;
  let rows: Row[] = [];
  let group: Group | undefined;
  let finalized = false;
  let endingLeaf: string | null | undefined;
  let leaf: string | null | undefined;
  // Weak keys only: a message_end replacement may differ from the original
  // object the host eventually mutates/persists. Entry boundaries reconcile that.
  let messageGroups = new WeakMap<object, string>();
  let captures = new WeakMap<Component, Capture>();
  // No text/context/state/component references in this set. Instance wrappers
  // survive a reset but look up capture pointers in the replaceable WeakMap.
  const wrappers = new WeakSet<Function>();

  function clear(): void {
    epoch++;
    rows = [];
    group = undefined;
    finalized = false;
    endingLeaf = leaf = undefined;
    messageGroups = new WeakMap();
    captures = new WeakMap();
  }
  function bounded(items: Row[]): Row[] {
    let visible = 0, empty = 0;
    return [...items].reverse().filter(item => item.block.text
      ? ++visible <= LIVE_HUD_MAX_TRANSCRIPT_BLOCKS
      : ++empty <= LIVE_HUD_MAX_TRANSCRIPT_BLOCKS).reverse();
  }
  function bound(): void { rows = bounded(rows); }
  function row(key: string, role: Role, text: string, previous: Row[], stamp?: number, slot?: number): Row {
    const old = previous.find(item => item.key === key && item.block.role === role);
    return { key, block: { id: old?.block.id ?? randomUUID(), role, text }, stamp, slot };
  }
  function tool(toolId: string, previous = rows): Row {
    const old = previous.find(item => item.toolId === toolId);
    return old ?? { key: `tool:${toolId}`, toolId, block: { id: randomUUID(), role: "tool", text: "" } };
  }
  function appendContent(target: Row[], source: unknown, key: string, previous: Row[], stamp?: number, live = false): void {
    if (!record(source)) return;
    const role = data(source, "role");
    const custom = role === "custom" || data(source, "type") === "custom_message";
    if (custom) {
      // Raw display:true is NOT proof of visible content. Only this known text
      // contract is safe; never instantiate a custom renderer or inspect details.
      if (data(source, "customType") !== "talk-history" || data(source, "display") !== true) return;
      const content = textParts(data(source, "content"));
      const match = typeof content === "string" ? /^\[talk:(user|assistant)\]\n([\s\S]*)$/.exec(content) : null;
      if (!match) return; // No legacy/XML/arbitrary custom fallback.
      const text = sanitizeTranscriptText(match[2]);
      if (text) target.push({ ...row(`${key}:0`, match[1] as Role, text, previous, stamp, 0), live });
      return;
    }
    if (role !== "user" && role !== "assistant") return;
    const content = data(source, "content");
    const parts = typeof content === "string" && role === "user" ? [{ type: "text", text: content }]
      : array(content) ? content : [];
    for (let slot = 0; slot < parts.length; slot++) {
      const part = data(parts, slot);
      const type = data(part, "type"), id = data(part, "id");
      if (role === "assistant" && type === "toolCall" && typeof id === "string" && id) {
        if (!target.some(item => item.toolId === id)) {
          target.push({ ...tool(id, previous), key: `${key}:${slot}`, stamp, slot, live });
        }
      } else if (type === "text") {
        const text = sanitizeTranscriptText(data(part, "text"));
        if (text) target.push({ ...row(`${key}:${slot}`, role, text, previous, stamp, slot), live });
      }
      // Never inspect thinking, signatures, images, tool arguments or details.
      // Unrendered/unsupported tool placeholders must not evict visible prose.
      // Both visible rows and empty call identities have independent small caps.
      if (target.length > 2 * LIVE_HUD_MAX_TRANSCRIPT_BLOCKS) target.splice(0, target.length, ...bounded(target));
    }
  }
  function entries(ctx: ExtensionContext): SessionEntry[] {
    // The pinned development dependency predates this host API. Do not import a
    // newer runtime symbol or silently select every entry from every branch.
    const manager = ctx.sessionManager as ExtensionContext["sessionManager"] & { buildContextEntries?: () => SessionEntry[] };
    if (typeof manager.buildContextEntries === "function") return manager.buildContextEntries();
    // Older hosts: mirror compaction selection on the ACTIVE branch only.
    const branch = manager.getBranch();
    let index = -1;
    for (let i = 0; i < branch.length; i++) if (data(branch[i], "type") === "compaction") index = i;
    if (index < 0) return branch;
    const compact = branch[index]!;
    const first = branch.findIndex(entry => data(entry, "id") === data(compact, "firstKeptEntryId"));
    return [compact, ...(first >= 0 && first < index ? branch.slice(first, index) : []), ...branch.slice(index + 1)];
  }
  function reconcile(ctx: ExtensionContext, force = false): boolean {
    if (!enabled) return false;
    try {
      const nextLeaf = ctx.sessionManager.getLeafId();
      // An async later message_end handler can still be running when a heartbeat
      // fires. Do not reconcile a provisional message against pre-persist history.
      if (finalized && nextLeaf === endingLeaf) return true;
      if (!force && !finalized && nextLeaf === leaf) return true;
      const previous = rows;
      const next: Row[] = [];
      let groupPersisted = false;
      let finalizedEntry: string | undefined;
      if (group && finalized) {
        // Use the ORIGINAL message's persistence position, not the replacement
        // object's identity/timestamp seen by our message_end handler. Ignore
        // unrelated custom appends while later handlers are still running.
        const branch = ctx.sessionManager.getBranch();
        let after = endingLeaf === null;
        for (const entry of branch) {
          const id = data(entry, "id");
          if (typeof id !== "string") continue;
          if (after && data(entry, "type") === "message") {
            const message = data(entry, "message");
            if (data(message, "role") === group.role) { finalizedEntry = id; break; }
          }
          if (id === endingLeaf) after = true;
        }
      }
      for (const entry of entries(ctx)) {
        const id = data(entry, "id");
        if (typeof id !== "string") continue;
        const key = `entry:${id}`;
        if (data(entry, "type") === "message") {
          // toolResult bodies are deliberately never read. A call placeholder
          // comes only from the main assistant's toolCall blocks, not nestedCalls.
          const message = data(entry, "message");
          const matches = !!group && data(message, "role") === group.role &&
            (id === finalizedEntry || (object(message) && messageGroups.get(message) === group.key));
          const prior = matches ? previous.map(item => item.live && item.key.startsWith(`${group!.key}:`)
            ? { ...item, key: key + item.key.slice(group!.key.length) } : item) : previous;
          if (matches) groupPersisted = true;
          appendContent(next, message, key, prior, timestamp(data(message, "timestamp")));
        } else if (data(entry, "type") === "custom_message") {
          appendContent(next, entry, key, previous);
        }
      }
      // A custom append alone is not proof of final persistence.
      const waiting = !!group && finalized && !groupPersisted && !force;
      if (group && !groupPersisted && (!finalized || waiting)) {
        for (const item of previous) if (item.live && item.key.startsWith(`${group.key}:`)) next.push(item);
      }
      rows = next;
      bound();
      if (finalized && !waiting) group = undefined;
      if (!waiting) finalized = false;
      if (!waiting) endingLeaf = undefined;
      leaf = nextLeaf;
      return true;
    } catch {
      // An invalidated manager must never leave an abandoned branch on screen.
      clear();
      return false;
    }
  }
  function update(message: unknown): void {
    if (!enabled || !group || !record(message) || data(message, "role") !== group.role) return;
    messageGroups.set(message, group.key);
    const previous = rows;
    const next = previous.filter(item => !(item.live && item.key.startsWith(`${group!.key}:`)));
    appendContent(next, message, group.key, previous, group.stamp, true);
    rows = next;
    bound();
  }
  function messageStart(ctx: ExtensionContext, message: unknown): void {
    if (!enabled) return;
    if (!reconcile(ctx, true)) return;
    const role = data(message, "role");
    if (!record(message) || (role !== "user" && role !== "assistant")) return;
    group = { key: randomUUID(), role, stamp: timestamp(data(message, "timestamp")) };
    messageGroups.set(message, group.key);
    update(message);
  }
  function messageEnd(ctx: ExtensionContext, message: unknown): void {
    if (!enabled) return;
    if (group && record(message) && data(message, "role") === group.role) messageGroups.set(message, group.key);
    // message_end handlers can still transform this message and persistence is
    // later. Read the manager at the next lifecycle boundary/heartbeat instead.
    finalized = true;
    try { endingLeaf = ctx.sessionManager.getLeafId(); } catch { clear(); }
  }
  function toolStart(toolId: string, parentToolCallId?: string): void {
    if (!enabled || parentToolCallId || !toolId || rows.some(item => item.toolId === toolId)) return;
    rows.push(tool(toolId));
    bound();
  }
  function capture(value: Capture, lines: string[]): void {
    if (!enabled || value.epoch !== epoch || !value.compact) return;
    const item = rows.find(item => item.toolId === value.toolId);
    if (!item) return;
    const text = sanitizeTranscriptText(lines.join("\n"), LIVE_HUD_MAX_TRANSCRIPT_TEXT, value.slot === "call" ? "head" : "tail");
    item[value.slot] = text;
    // One compact block per call, with independently replaceable call/result
    // slots. Reserve room for an actual result rather than a huge call preview.
    if (item.call && item.result) {
      item.call = clip(item.call, Math.min(768, LIVE_HUD_MAX_TRANSCRIPT_TEXT));
      item.result = clipTail(item.result, Math.max(0, LIVE_HUD_MAX_TRANSCRIPT_TEXT - Buffer.byteLength(item.call) - 1));
    }
    item.block.text = [item.call, item.result].filter(Boolean).join("\n");
    bound();
  }
  function observe(component: Component, context: RenderContext, slot: Capture["slot"], compact: boolean): void {
    if (!component || !context) return;
    if (!enabled) { captures.delete(component); return; }
    const toolId = context.toolCallId;
    if (typeof toolId !== "string" || !rows.some(item => item.toolId === toolId)) {
      captures.delete(component);
      return;
    }
    const prior = captures.get(component);
    if (prior?.epoch === epoch && prior.toolId === toolId && prior.slot !== slot) {
      // A self renderer may use the very same component in both slots. Its
      // actual output belongs to the latest slot, not two duplicate previews.
      const item = rows.find(item => item.toolId === toolId);
      if (item) { item[prior.slot] = ""; item.block.text = [item.call, item.result].filter(Boolean).join("\n"); }
    }
    captures.set(component, { epoch, toolId, slot, compact });
    const original = component.render;
    if (wrappers.has(original)) return;
    const own = Object.getOwnPropertyDescriptor(component, "render");
    if (own && (!Object.hasOwn(own, "value") || own.writable === false)) return;
    const observed = function (this: Component, width: number): string[] {
      // The actual component renders exactly once, with its original receiver.
      // Return the very same lines; never mutate terminal output or invalidate.
      const lines = original.call(this, width);
      try { const pointer = captures.get(this); if (pointer) capture(pointer, lines); } catch { /* Presentation cannot break a render. */ }
      return lines;
    };
    try {
      Object.defineProperty(component, "render", { value: observed, configurable: own?.configurable ?? true,
        writable: own?.writable ?? true, enumerable: own?.enumerable ?? false });
      wrappers.add(observed);
    } catch { captures.delete(component); /* Frozen components remain untouched. */ }
  }

  // Feature detection supports the 0.87.1 project types and 1.3.0 host. Missing
  // hook means NO tool capture: never synthesize previews from raw inputs/results.
  // The public context does not identify a presentation: matching compact HTML
  // export renders can also be observed; their expanded pass is always excluded.
  const api = pi as ExtensionAPI & { registerToolRenderer?: (resolver: Resolver) => void };
  if (typeof api.registerToolRenderer === "function") api.registerToolRenderer((_name, next) => {
    const renderers = next();
    if (!renderers) return renderers;
    const call = renderers.renderCall, result = renderers.renderResult;
    return {
      ...renderers,
      ...(call ? { renderCall: function (this: unknown, ...args: Parameters<CallRenderer>) {
        const component = call.apply(this, args);
        if (enabled) try { observe(component, args[2], "call", args[2]?.expanded === false); } catch { /* Transparent decorator. */ }
        return component;
      } } : {}),
      ...(result ? { renderResult: function (this: unknown, ...args: Parameters<NonNullable<Renderers["renderResult"]>>) {
        const component = result.apply(this, args);
        if (enabled) try { observe(component, args[3], "result", args[3]?.expanded === false && args[1]?.expanded === false); } catch { /* Transparent decorator. */ }
        return component;
      } } : {}),
    };
  });

  return {
    start(ctx: ExtensionContext): void { enabled = true; clear(); reconcile(ctx, true); },
    stop(): void { enabled = false; clear(); },
    reset(ctx?: ExtensionContext): void { clear(); if (ctx) reconcile(ctx, true); },
    reconcile,
    messageStart,
    messageUpdate: update,
    messageEnd,
    toolStart,
    snapshot(ctx: ExtensionContext | undefined): LiveHudTranscriptBlock[] {
      if (!enabled) return [];
      if (ctx) reconcile(ctx);
      const tail: LiveHudTranscriptBlock[] = [];
      let budget = LIVE_HUD_MAX_TRANSCRIPT_BYTES;
      for (const item of [...rows].reverse()) {
        const text = clipTail(item.block.text, Math.min(budget, LIVE_HUD_MAX_TRANSCRIPT_TEXT));
        if (!text || !text.trim()) continue;
        tail.push({ id: item.block.id, role: item.block.role, text });
        budget -= Buffer.byteLength(text);
        if (!budget || tail.length >= LIVE_HUD_MAX_TRANSCRIPT_BLOCKS) break;
      }
      return tail.reverse();
    },
  };
}

#!/usr/bin/env node
// Local-only, dependency-free Markdown view of Talk's private JSONL trace.
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { StringDecoder } from "node:string_decoder";

export const defaultPath = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "logs", "talk", "events.jsonl");
const text = (item) => (item?.content ?? []).map(part => part.text ?? "").filter(Boolean).join("\n");
// Strip terminal controls from untrusted conversation text (retain newlines/tabs).
const safe = (value) => String(value ?? "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

function readableBody(value) {
  const body = safe(value).trim();
  if (/^[{[]/.test(body)) {
    try { return JSON.stringify(JSON.parse(body), null, 2).split("\n").map(line => `    ${line}`).join("\n"); }
    catch { /* Not a JSON control: keep the original prose. */ }
  }
  return body;
}

// Keep terminal presentation separate so exports remain ordinary Markdown.
export function renderTerminal(markdown) {
  let background = "";
  return safe(markdown).trimEnd().split("\n").map(line => {
    if (/^\[(PI|GPT-LIVE|USER)\] \[(DELEGATION|SESSION|VOICE)\](?: \[[^\]\n]+\])*$/.test(line)) {
      if (line.includes("[VOICE]")) background = "100;97";
      else if (line.includes("[DELEGATION]")) background = "45;97";
      else background = "43;30";
      line = `\x1b[1m${line}\x1b[22m`;
    } else if (line.startsWith("# ")) {
      background = "";
      line = `\x1b[1m${line.slice(2)}\x1b[22m`;
    } else {
      line = line.replace(/\*\*([^*\n]+)\*\*/g, "\x1b[1m$1\x1b[22m")
        .replace(/`([^`\n]+)`/g, "\x1b[4m$1\x1b[24m");
    }
    // Erase to the right edge in the block's background, including blank lines.
    // Background stays active during terminal wrapping, then resets per line.
    return background ? `\x1b[${background}m ${line}\x1b[K\x1b[0m` : `${line}\x1b[0m`;
  }).join("\n") + "\n\n";
}

// Speech chunks deliberately retain literal Markdown: styling partial tokens would
// require buffering them, delaying speech. Every write restores terminal defaults.
export function renderSpeechChunk(chunk, mode) {
  const gray = "\x1b[100;97m";
  const endLine = "\x1b[K\x1b[0m\n";
  if (mode === "end") return `${gray}${endLine}\n`;
  let value = safe(chunk);
  let prefix = gray;
  if (mode === "start") {
    const newline = value.indexOf("\n");
    prefix += ` \x1b[1m${value.slice(0, newline)}\x1b[22m${endLine}${gray} `;
    value = value.slice(newline + 1);
  }
  return prefix + value.replace(/\n/g, `${endLine}${gray} `) + "\x1b[K\x1b[0m";
}

export function formatRecord(row) {
  const event = row.event ?? {};
  const type = row.type ?? event.type;
  const block = (header, body) => body ? `${safe(header)}\n${readableBody(body)}\n\n` : "";
  if (type === "turn.done") {
    const role = event.turn?.role;
    if (!["user", "assistant"].includes(role)) return "";
    return block(`[${role === "assistant" ? "GPT-LIVE" : "USER"}] [VOICE]`, event.turn.transcript);
  }
  if (type === "delegation.created") {
    return block(`[GPT-LIVE] [DELEGATION] [CREATE] [${event.item?.id ?? "unknown"}]`, text(event.item));
  }
  if (type === "session.context.append" || type === "delegation.context.append") {
    if (!["commentary", "speakable"].includes(event.channel)) return "";
    const delegation = type.startsWith("delegation.");
    const action = event.channel === "speakable" ? "SPEAKABLE" : "CONTEXT";
    return block(`[PI] [${delegation ? "DELEGATION" : "SESSION"}] [${action}]${delegation ? ` [${event.delegation_item_id ?? "unknown"}]` : ""}`, text(event));
  }
  if (type === "trace.session_snapshot") {
    return block("[PI] [SESSION] [STARTUP SNAPSHOT]", "Original startup configuration (logging enabled mid-call), not a new send.") + formatRecord({ ...row, type: event.startup?.type, event: event.startup });
  }
  if (type === "codex.call.create") {
    const startup = [event.session?.instructions, ...(event.session?.initial_items ?? []).map(text)].filter(Boolean).join("\n\n");
    return block("[PI] [SESSION] [STARTUP]", startup);
  }
  return ""; // Streaming is handled by the parser; skip diagnostics and duplicate transcript events.
}

// Concatenating emitted strings yields plain Markdown. Optional { speech } metadata
// selects chunk rendering instead of whole-block rendering; flush() closes at EOF.
export function createParser(emit, warn = () => {}, onSessionChange = () => {}) {
  let pending = "";
  let callId;
  const turns = new Map();
  const anonymous = { user: Symbol("anonymous user turn"), assistant: Symbol("anonymous assistant turn") };
  let latestAnonymous = anonymous.user;
  const speaker = role => role === "assistant" ? "GPT-LIVE" : "USER";
  let openSpeech;
  const flush = () => {
    if (openSpeech) emit("\n\n", { speech: "end" });
    openSpeech = undefined;
  };
  const clearSpeech = () => { flush(); turns.clear(); latestAnonymous = anonymous.user; };
  const append = (turn, fragment) => {
    fragment = safe(fragment);
    if (!fragment) return;
    turn.transcript += fragment;
    if (openSpeech !== turn) {
      flush();
      emit(`[${speaker(turn.role)}] [VOICE]${turn.displayed ? " [CONTINUED]" : ""}\n${fragment}`, { speech: "start" });
      openSpeech = turn;
      turn.displayed = true;
    } else emit(fragment, { speech: "delta" });
  };
  const display = row => {
    const event = row.event ?? {};
    const type = row.type ?? event.type;
    const role = event.turn?.role;
    const knownRole = role === "user" || role === "assistant";
    const key = event.turn?.id ?? event.turn_id ?? (knownRole ? anonymous[role] : latestAnonymous);
    if (type === "turn.created" && knownRole) {
      // ID-less deltas can only be associated with the latest ID-less creation.
      if (key === anonymous[role]) latestAnonymous = key;
      if (key === anonymous[role] || !turns.has(key)) {
        const turn = { role, transcript: "", displayed: false };
        turns.set(key, turn);
        append(turn, event.turn.transcript ?? "");
      }
      return;
    }
    if (type === "turn.delta") {
      const turn = turns.get(key);
      if (turn && !turn.done && typeof event.delta === "string") append(turn, event.delta);
      return;
    }
    if (type === "turn.done" && knownRole) {
      const turn = turns.get(key);
      const final = safe(event.turn.transcript ?? "");
      if (turn?.displayed) {
        // Empty/missing finals carry no correction. Never replay matching text.
        if (final.trim() && final.trim() !== turn.transcript.trim()) {
          flush();
          emit(`[${speaker(role)}] [VOICE] [FINAL/CORRECTION]\n${readableBody(final)}\n\n`);
          turn.transcript = final;
        }
      } else {
        const output = formatRecord(row);
        if (output) {
          flush();
          emit(output);
          if (turn) { turn.transcript = final; turn.displayed = true; }
        }
      }
      if (turn) {
        turn.done = true;
        if (openSpeech === turn) flush();
      }
      else if (event.turn?.id) turns.set(key, { role, transcript: final, displayed: Boolean(final.trim()), done: true });
      return;
    }
    const output = formatRecord(row);
    if (output) { flush(); emit(output); }
  };
  return {
    flush,
    reset() { pending = ""; callId = undefined; clearSpeech(); },
    push(chunk) {
      pending += chunk;
      let end;
      while ((end = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); }
        catch { warn("Skipped malformed Talk log record."); continue; }
        if (!row || typeof row !== "object" || Array.isArray(row)) { warn("Skipped malformed Talk log record."); continue; }
        if (row.callId) {
          if (callId && row.callId !== callId) { clearSpeech(); onSessionChange(); }
          callId = row.callId;
        }
        display(row);
      }
      if (pending.length > 1024 * 1024) { pending = ""; warn("Skipped oversized Talk log record."); }
    },
  };
}

// Erase scrollback as well as the visible screen before redrawing.
export const CLEAR_TERMINAL = "\x1b[3J\x1b[2J\x1b[H";

export function logWasReset(previous, current) {
  return Boolean(previous.identity && (previous.identity !== current.identity ||
    current.size < previous.position || !current.prefix.subarray(0, previous.prefix.length).equals(previous.prefix)));
}

export async function monitor(path, { once = false, plain = false, signal } = {}) {
  const color = process.stdout.isTTY && !plain && !process.env.NO_COLOR;
  const emit = (value, { speech } = {}) => process.stdout.write(color
    ? (speech ? renderSpeechChunk(value, speech) : renderTerminal(value)) : value);

  const parser = createParser(emit, message => process.stderr.write(`${message}\n`), () => resetView("New Talk call detected."));
  let position = 0;
  let decoder = new StringDecoder("utf8");
  let identity;
  let prefix = Buffer.alloc(0);
  let waiting = false;
  const header = () => {
    emit(`# Talk monitor\n\n${safe(path)}\n\n`);
    if (color) emit("**Blocks:** Purple: delegation · Yellow: session / startup · Gray: user / GPT-Live voice\nBoth voices stream live; CONTINUED resumes after other output; FINAL/CORRECTION replaces provisional text.\n\n");
  };
  const resetView = reason => {
    if (process.stdout.isTTY && !plain) {
      process.stdout.write(CLEAR_TERMINAL);
      header();
    }
    emit(`---\n\n**Log reset / new session** — ${reason}\n\n`);
  };
  if (process.stdout.isTTY && !plain) process.stdout.write(CLEAR_TERMINAL);
  header();
  try {
    do {
      let file;
      try {
        file = await open(path, "r");
        const stat = await file.stat();
        const nextIdentity = `${stat.dev}:${stat.ino}`;
        // Check the beginning too: a new session can refill the file beyond our
        // old offset between polls, hiding a truncate if we only compare sizes.
        const firstBytes = Buffer.alloc(Math.min(256, stat.size));
        const { bytesRead } = await file.read(firstBytes, 0, firstBytes.length, 0);
        const nextPrefix = firstBytes.subarray(0, bytesRead);
        if (logWasReset({ identity, position, prefix }, { identity: nextIdentity, size: stat.size, prefix: nextPrefix })) {
          position = 0;
          parser.reset();
          decoder = new StringDecoder("utf8");
          resetView("Previous log cleared or rotated.");
        }
        identity = nextIdentity;
        prefix = nextPrefix;
        waiting = false;
        // Decode as a stream: a filesystem read can split a UTF-8 character.
        if (stat.size > position) {
          const stream = file.createReadStream({ start: position, end: stat.size - 1, autoClose: false });
          for await (const chunk of stream) parser.push(decoder.write(chunk));
          position = stat.size;
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (once) throw error;
        if (!waiting) process.stderr.write(`Waiting for ${path} — enable /talk log on.\n`);
        waiting = true;
      } finally {
        await file?.close();
      }
      if (once || signal?.aborted) break;
      try { await sleep(250, undefined, { signal }); } catch (error) { if (error.name !== "AbortError") throw error; }
    } while (!signal?.aborted);
  } finally { parser.flush(); }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: node scripts/talk-monitor.mjs [--once] [--plain] [path]\n\nFollows Talk's log from the beginning. Ctrl-C exits.\nLive user/assistant speech, startup context and delegation/session updates use compact sender-first headers (delegation ID last).\nInterleaved speech resumes as CONTINUED; changed finals show FINAL/CORRECTION.\nColors: purple delegation, yellow session/startup, gray user/assistant voice.\n--once   Render existing records and exit\n--plain  Plain Markdown (also automatic when redirected)");
    return;
  }
  const paths = args.filter(arg => !arg.startsWith("--"));
  if (paths.length > 1 || args.some(arg => arg.startsWith("--") && !["--once", "--plain"].includes(arg))) throw new Error("Unknown arguments; use --help.");
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.stdout.on("error", error => { if (error.code === "EPIPE") process.exit(0); else throw error; });
  try { await monitor(paths[0] ?? defaultPath, { once: args.includes("--once"), plain: args.includes("--plain"), signal: controller.signal }); }
  finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

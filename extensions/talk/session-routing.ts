import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTalkSessionHub, connectTalkSession, type TalkSessionHub } from "./multisession-transport.ts";
import type { TalkSessionClient, TalkSessionMetadata, TalkSessionPeer, TalkJson, TalkSessionIdentity } from "./multisession-protocol.ts";
import { createSessionVoiceReceiver, handoffSummary, type VoiceHandoff } from "./session-voice.ts";
import { record } from "./multisession-protocol.ts";

/** Explicit opt-in only. Neither receiver setup nor projection claims an audio/HUD endpoint. */
export function createTalkSessionRouting(pi: ExtensionAPI, options: {
  socketPath: string;
  activity(): string;
  summarize(ctx: ExtensionContext, signal: AbortSignal): Promise<string | undefined>;
  transfer(peer?: TalkSessionPeer, handoff?: VoiceHandoff): Promise<void>;
  activePeer(): TalkSessionPeer | undefined;
  output(peer: TalkSessionPeer, payload: TalkJson): void;
  lost(peer: TalkSessionPeer): void;
  sessions?(sessions: TalkSessionIdentity[]): void;
  snapshot?(peer: TalkSessionPeer, payload: TalkJson): void;
  receiveChanged?(enabled: boolean, ctx?: ExtensionContext): void;
}) {
  let hub: TalkSessionHub | undefined;
  let client: TalkSessionClient | undefined;
  let attached: { ctx: ExtensionContext; metadata: TalkSessionMetadata } | undefined;
  let generation = 0;
  let connecting = false;
  const receiver = createSessionVoiceReceiver(pi, {
    context: () => client?.connected ? attached?.ctx : undefined,
    summarize: options.summarize, activity: options.activity,
    name: () => attached?.metadata.name ?? "",
    send: (event, payload) => { client?.notify(event, payload); },
  });
  function metadata(ctx: ExtensionContext, main: boolean): TalkSessionMetadata {
    const name = pi.getSessionName?.() ?? ctx.sessionManager.getSessionName?.();
    if (!name && !main) throw new Error("Name this Pi session with /name before /talk receive on");
    return { sessionId: ctx.sessionManager.getSessionId(), name: name || "main", cwd: ctx.cwd,
      state: ctx.isIdle() ? "idle" : "working", activity: options.activity().replace(/\s+/g, " ").slice(0, 512) };
  }
  function update() {
    if (!attached) return;
    const value = { ...attached.metadata, state: attached.ctx.isIdle() ? "idle" as const : "working" as const,
      activity: options.activity().replace(/\s+/g, " ").slice(0, 512) };
    try { hub?.updateMain(value); } catch { /* Closing. */ }
    void client?.update(value).catch(() => {});
  }
  async function close() {
    generation++;
    connecting = false;
    receiver.close();
    const previousClient = client, previousHub = hub;
    client = undefined; hub = undefined; attached = undefined;
    previousClient?.close();
    options.receiveChanged?.(false);
    options.sessions?.([]);
    await previousHub?.close();
  }
  async function main(ctx: ExtensionContext) {
    if (hub) return;
    if (client || connecting) throw new Error("Use /talk receive off before owning FaceTime main");
    const info = metadata(ctx, true);
    const token = ++generation;
    connecting = true;
    attached = { ctx, metadata: info };
    try {
      const created = await createTalkSessionHub({
        socketPath: options.socketPath, main: attached.metadata,
        onSessions: values => options.sessions?.(values),
        onRequest: async (peer, method, payload) => {
          // No RPC endpoint for destination-to-destination transfer or FaceTime controls.
          if (method !== "voice.return" || options.activePeer() !== peer) throw new Error("Only the active destination may return to main");
          const summary = handoffSummary(record(payload) ? payload.summary : undefined);
          if (await peer.request("voice.pending", {}) !== false) throw new Error("Finish the pending questionnaire before returning");
          if (options.activePeer() !== peer) throw new Error("The active destination changed");
          await options.transfer(undefined, { origin: { name: peer.identity.name, cwd: peer.identity.cwd }, summary });
          return { returned: true };
        },
        onEvent(peer, event, payload) {
          if (event === "voice.output") options.output(peer, payload);
          else if (event === "session.snapshot") options.snapshot?.(peer, payload);
        },
        onDisconnect(peer) { options.lost(peer); },
      });
      if (generation !== token) { await created.close(); return; }
      hub = created;
      options.sessions?.(hub.sessions());
    } catch (error) { if (generation === token) attached = undefined; throw error; }
    finally { if (generation === token) connecting = false; }
  }
  async function receive(ctx: ExtensionContext) {
    if (client) return;
    if (hub || connecting) throw new Error("Stop FaceTime main before opting in as a receiver");
    const info = metadata(ctx, false);
    const token = ++generation;
    connecting = true;
    attached = { ctx, metadata: info };
    try {
      const connected = await connectTalkSession({ socketPath: options.socketPath, session: info,
        onRequest: (method, payload) => receiver.request(method, payload),
        onEvent: (event, payload) => receiver.event(event, payload),
        onDisconnect() {
          if (generation !== token) return;
          generation++; connecting = false; // Fence a welcome whose await has not resumed yet.
          receiver.close(); client = undefined; attached = undefined;
          options.receiveChanged?.(false);
          ctx.ui.notify("Talk main disconnected. Receive opt-in withdrawn; submitted Pi work continues. Nothing will be replayed. Use /talk receive on to reconnect explicitly.", "warning");
        },
      });
      if (generation !== token) { connected.close(); return; }
      client = connected;
      options.receiveChanged?.(true, ctx);
      ctx.ui.notify(`Talk receive on: ${info.name} — ${info.cwd}. Remote voice questionnaires and voice Stop are unavailable; use this terminal.`, "info");
    } catch (error) { if (generation === token) attached = undefined; throw error; }
    finally { if (generation === token) connecting = false; }
  }
  pi.on("session_info_changed", (_event, ctx) => {
    if (attached) ctx.ui.notify(`Talk attachment keeps the name “${attached.metadata.name}” until detached. Rename takes effect on the next explicit opt-in.`, "info");
  });
  pi.on("session_before_switch", close);
  pi.on("session_before_tree", close);
  pi.on("session_before_fork", close);
  pi.on("session_shutdown", close);
  pi.on("session_start", close);
  pi.on("agent_start", update);
  pi.on("agent_settled", update);
  return {
    main, receive, close, update, pending: receiver.pending,
    voiceActive: receiver.active, beforeStart: receiver.beforeStart,
    receiving: () => !!client || connecting && !hub,
    sessions: () => hub?.sessions() ?? [],
    async transfer(name: string, summary?: string) {
      if (!hub) throw new Error("Transfers require /talk facetime in main");
      const main = hub.sessions().find(value => value.isMain)!;
      const origin = options.activePeer()?.identity ?? main;
      const handoff = { origin: { name: origin.name, cwd: origin.cwd }, summary: handoffSummary(summary) };
      if (name === main.name) { await options.transfer(undefined, handoff); return; }
      const peer = hub.getPeer(name);
      if (!peer || peer.identity.state === "unavailable") throw new Error("No available opted-in session with that exact name");
      await options.transfer(peer, handoff);
    },
    async returnToMain(summary?: string) {
      if (!client || !attached) throw new Error("This session is not opted in to Talk main");
      if (receiver.pending()) throw new Error("Finish the pending questionnaire before returning");
      const concise = handoffSummary(summary);
      return client.request("voice.return", concise === undefined ? {} : { summary: concise });
    },
    activity(messages: string[]) { update(); receiver.activity(messages); },
    publishSnapshot(snapshot: unknown) {
      if (!client) return;
      try { client.notify("session.snapshot", JSON.parse(JSON.stringify(snapshot)) as TalkJson); } catch { /* No snapshot replay queue. */ }
    },
  };
}

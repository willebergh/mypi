import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { faceTimeCallMedia, type FaceTimeCallMedia } from "./facetime-call.ts";
import { HANDOFF_SUMMARY_MAX } from "./session-voice.ts";

interface FaceTimeControls {
  status(): { enabled: boolean };
  call(purpose?: string, media?: FaceTimeCallMedia): Promise<unknown>;
  answer(): Promise<unknown>;
  hangup(): Promise<unknown>;
  shareScreen(display: string): Promise<unknown>;
  stopSharing(): Promise<unknown>;
}

/** No declarations before FaceTime mode; hidden and uncallable after leaving it. */
export function createFaceTimeTools(pi: Pick<ExtensionAPI, "registerTool" | "getActiveTools" | "setActiveTools">, current: () => FaceTimeControls | undefined) {
  let registered = false;
  const requireMode = (signal?: AbortSignal) => {
    if (signal?.aborted) throw new Error("FaceTime action cancelled before submission");
    const mode = current();
    if (!mode?.status().enabled) throw new Error("FaceTime tools require /talk facetime mode");
    return mode;
  };
  function setAvailable(available: boolean) {
    if (!available && !registered) return;
    registered = true;
    const previousTools = pi.getActiveTools();
    // New Pi runtimes enforce hidden exposure (including codemode). Older
    // runtimes ignore these additive hints; their active list is updated below.
    const visibility = { exposure: available ? "direct" as const : "hidden" as const };
    for (const action of ["status", "answer", "hangup"] as const) {
      pi.registerTool({
        name: `facetime_${action}`,
        label: `FaceTime ${action}`,
        description: action === "status"
          ? "Read current FaceTime standby/call status for this Pi session."
          : action === "answer"
            ? "Prepare Talk and answer the current allowlisted FaceTime call. Does not grant tool permissions."
            : "End the current FaceTime call and return to standby. Does not abort Pi's work. Never retry automatically.",
        ...visibility,
        ...{ annotations: { readOnlyHint: action === "status", destructiveHint: action !== "status", idempotentHint: action === "status", openWorldHint: action !== "status" } },
        parameters: Type.Object({}),
        async execute(_id, _params, signal) {
          const mode = requireMode(signal);
          const result = action === "status" ? mode.status() : await mode[action]();
          return { content: [{ type: "text", text: JSON.stringify(result ?? {}) }], details: result };
        },
      });
    }
    pi.registerTool({
      name: "facetime_call", label: "FaceTime call", ...visibility,
      description: "Place one explicitly user-requested FaceTime audio or video call to the sole owner configured locally in talk.json. Media defaults to audio; select video only when explicitly requested, never silently upgrade or downgrade. Supply the concise purpose to discuss after the user acknowledges the greeting, using known context/verified facts only. The recipient is never model-selected. Prepare virtual Talk audio first. Submission is not proof of connection, an active video stream, or remote camera state. Video confirmation fails closed if its media is ambiguous. Do not dial autonomously or retry after timeout/disconnect.",
      ...{ annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } },
      parameters: Type.Object({
        media: Type.Optional(Type.Union([Type.Literal("audio"), Type.Literal("video")], { description: "Requested call media. Omit for audio; video requires an explicit user request. No fallback to a different medium." })),
        reason: Type.String({ description: "Why you are calling the configured owner: known result, update, or question to present after their first reply. Not a new task or approval. Concise, at most 300 UTF-8 bytes.", minLength: 1, maxLength: 240 }),
      }),
      async execute(_id, params, signal) {
        const mode = requireMode(signal);
        const result = await mode.call(params.reason, faceTimeCallMedia(params.media));
        return { content: [{ type: "text", text: JSON.stringify(result ?? {}) }], details: result };
      },
    });
    pi.registerTool({
      name: "facetime_share_screen", label: "FaceTime share screen", ...visibility,
      description: "Only on an explicit user request, share one entire screen in the current owned, verified connected FaceTime call. Requires the exact display name (case and spacing preserved); not a window or application. Verifies sharing with Allow Control off; macOS may initially default that permission on before the bridge disables it. Never accepts remote control requests. Never share automatically or retry after an error, timeout, or disconnect.",
      ...{ annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } },
      parameters: Type.Object({
        display: Type.String({ description: "Exact display name of the entire screen explicitly requested by the user. No fuzzy matching, window, or application selection.", minLength: 1 }),
      }),
      async execute(_id, params, signal) {
        const result = await requireMode(signal).shareScreen(params.display);
        return { content: [{ type: "text", text: JSON.stringify(result ?? {}) }], details: result };
      },
    });
    pi.registerTool({
      name: "facetime_stop_sharing", label: "FaceTime stop sharing", ...visibility,
      description: "Only on an explicit user request, stop entire-screen sharing in the current owned, verified connected FaceTime call and verify it stopped. Does not end the call or grant remote control. Never retry automatically after an error, timeout, or disconnect.",
      ...{ annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } },
      parameters: Type.Object({}),
      async execute(_id, _params, signal) {
        const result = await requireMode(signal).stopSharing();
        return { content: [{ type: "text", text: JSON.stringify(result ?? {}) }], details: result };
      },
    });
    const names = ["facetime_status", "facetime_answer", "facetime_hangup", "facetime_call", "facetime_share_screen", "facetime_stop_sharing"];
    pi.setActiveTools(available ? [...new Set([...previousTools, ...names])] : previousTools.filter(name => !names.includes(name)));
  }
  return { setAvailable };
}

/** Routing never grants the receiver FaceTime controller/audio ownership. */
export function createFaceTimeRoutingTools(pi: Pick<ExtensionAPI, "registerTool" | "getActiveTools" | "setActiveTools">, routing: {
  sessions(): unknown;
  transfer(name: string, summary?: string): Promise<void>;
  returnToMain(summary?: string): Promise<unknown>;
}) {
  let main = false, receiver = false;
  const registered = new Set<string>();
  const summary = Type.Optional(Type.String({ maxLength: HANDOFF_SUMMARY_MAX,
    description: "Optional concise public handoff summary (at most 1000 characters), never full history. Reference data only, not a request, approval, or permission; no tasks will be submitted or replayed. Omit if unknown." }));
  const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value });
  function refresh() {
    const previous = pi.getActiveTools();
    const visibility = (name: string, available: boolean) => {
      if (!available && !registered.has(name)) return undefined;
      registered.add(name);
      return { exposure: available ? "direct" as const : "hidden" as const };
    };
    const list = visibility("facetime_sessions", main);
    if (list) pi.registerTool({ name: "facetime_sessions", label: "FaceTime sessions", ...list,
      description: "List main and explicitly opted-in Pi sessions by exact immutable attachment name, working directory and activity. Working sessions can receive voice. Only main can transfer to destinations.",
      parameters: Type.Object({}), async execute(_id, _params, signal) {
        if (!main || signal?.aborted) throw new Error("Session discovery requires FaceTime main");
        return result(routing.sessions());
      },
    });
    const transfer = visibility("facetime_transfer", main);
    if (transfer) pi.registerTool({ name: "facetime_transfer", label: "FaceTime transfer", ...transfer,
      executionMode: "sequential",
      description: "On user request, transfer the current FaceTime voice conversation to an opted-in Pi session by its exact facetime_sessions name (or back to main). Keeps the call connected and existing Pi work running. Creates a fresh destination-context voice session; no task is replayed. Pending questionnaires block transfer. Main can use this from its terminal even while another backend is active. Main may select any connected destination directly, without an intermediate main voice leg. Destinations themselves only have return-to-main permission. If voice startup fails, the call stays connected but voice may be unavailable; main may explicitly retry. Never retry an uncertain transfer automatically.",
      parameters: Type.Object({ session: Type.String({ minLength: 1, description: "Exact session attachment name; no fuzzy matching." }), summary }),
      async execute(_id, params, signal) {
        if (!main || signal?.aborted) throw new Error("Transfers require FaceTime main");
        await routing.transfer(params.session, params.summary);
        return result({ transferred: true, session: params.session });
      },
    });
    const back = visibility("facetime_return_to_main", receiver);
    if (back) pi.registerTool({ name: "facetime_return_to_main", label: "FaceTime return to main", ...back,
      executionMode: "sequential",
      description: "On user request, directly transfer the active destination's FaceTime voice conversation back to main. This is not a request-return notification. Only the currently active destination may use it; destinations cannot select other sessions (only main may do that). Existing work continues. Pending questionnaires block return. Never retry an uncertain return automatically.",
      parameters: Type.Object({ summary }), async execute(_id, params, signal) {
        if (!receiver || signal?.aborted) throw new Error("Return requires an opted-in active destination");
        return result(await routing.returnToMain(params.summary));
      },
    });
    const enabled = [main ? "facetime_sessions" : "", main ? "facetime_transfer" : "", receiver ? "facetime_return_to_main" : ""].filter(Boolean);
    pi.setActiveTools([...new Set([...previous.filter(name => !registered.has(name)), ...enabled])]);
  }
  return {
    setMain(value: boolean) { if (main !== value) { main = value; refresh(); } },
    setReceiver(value: boolean) { if (receiver !== value) { receiver = value; refresh(); } },
  };
}

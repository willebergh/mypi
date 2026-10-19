import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { faceTimeCallMedia, type FaceTimeCallMedia } from "./facetime-call.ts";

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

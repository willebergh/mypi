import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface FaceTimeControls {
  status(): { enabled: boolean };
  call(to: string, purpose?: string): Promise<unknown>;
  answer(): Promise<unknown>;
  hangup(): Promise<unknown>;
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
      description: "Place one explicitly requested FaceTime Audio call to an exact allowlisted phone number or email. Supply the concise purpose you want to discuss after the user acknowledges the greeting, using known context/verified facts only. Prepare virtual Talk audio first. A successful submission is not proof of connection. Do not dial autonomously or retry after timeout/disconnect.",
      ...{ annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } },
      parameters: Type.Object({
        to: Type.String({ description: "Exact phone number or email configured in the local Swift recipient allowlist", minLength: 1, maxLength: 512 }),
        reason: Type.String({ description: "Why you are calling: known result, update, or question to present after the user's first reply. Not a new task or approval. Concise, at most 300 UTF-8 bytes.", minLength: 1, maxLength: 240 }),
      }),
      async execute(_id, params, signal) {
        const result = await requireMode(signal).call(params.to, params.reason);
        return { content: [{ type: "text", text: JSON.stringify(result ?? {}) }], details: result };
      },
    });
    const names = ["facetime_status", "facetime_answer", "facetime_hangup", "facetime_call"];
    pi.setActiveTools(available ? [...new Set([...previousTools, ...names])] : previousTools.filter(name => !names.includes(name)));
  }
  return { setAvailable };
}

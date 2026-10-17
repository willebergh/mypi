import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFaceTimeTools } from "../extensions/talk/facetime-tools.ts";

test("FaceTime tools exist only in mode, preserve other tools, and reject stale execution", async () => {
  const definitions = new Map<string, any>();
  let active = ["read", "bash"];
  let mode: any;
  const calls: string[] = [], reasons: (string | undefined)[] = [];
  const pi = {
    registerTool(tool: any) { definitions.set(tool.name, tool); },
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) { active = names; },
  } as unknown as Pick<ExtensionAPI, "registerTool" | "getActiveTools" | "setActiveTools">;
  const tools = createFaceTimeTools(pi, () => mode);
  tools.setAvailable(false);
  assert.equal(definitions.size, 0);
  mode = {
    status: () => ({ enabled: true, phase: "standby" }),
    call: async (to: string, reason?: string) => { calls.push(to); reasons.push(reason); return { submitted: true }; },
    answer: async () => { calls.push("answer"); return {}; },
    hangup: async () => { calls.push("hangup"); return {}; },
  };
  tools.setAvailable(true);
  assert.equal(definitions.size, 4);
  assert.deepEqual(active, ["read", "bash", "facetime_status", "facetime_answer", "facetime_hangup", "facetime_call"]);
  assert.ok([...definitions.values()].every(tool => tool.exposure === "direct"));
  const call = definitions.get("facetime_call");
  assert.ok(call.parameters.required.includes("reason"));
  await call.execute("t", { to: "+46000000000", reason: "Report the verified test result." }, undefined);
  assert.deepEqual(calls, ["+46000000000"]);
  assert.deepEqual(reasons, ["Report the verified test result."]);
  const status = await definitions.get("facetime_status").execute("s", {}, undefined);
  assert.equal(status.details.phase, "standby");
  const abort = new AbortController(); abort.abort();
  await assert.rejects(call.execute("t", { to: "+46000000000" }, abort.signal), /cancelled/);
  mode = undefined;
  tools.setAvailable(false);
  assert.deepEqual(active, ["read", "bash"]);
  assert.ok([...definitions.values()].every(tool => tool.exposure === "hidden"));
  await assert.rejects(call.execute("stale", { to: "+46000000000" }), /require \/talk facetime/);
  assert.equal(calls.length, 1);
});

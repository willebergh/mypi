import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFaceTimeTools } from "../extensions/talk/facetime-tools.ts";

test("FaceTime tools exist only in mode, preserve other tools, and reject stale execution", async () => {
  const definitions = new Map<string, any>();
  let active = ["read", "bash"];
  let mode: any;
  const calls: string[] = [], reasons: (string | undefined)[] = [], displays: string[] = [];
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
    call: async (reason?: string) => { calls.push("owner"); reasons.push(reason); return { submitted: true }; },
    answer: async () => { calls.push("answer"); return {}; },
    hangup: async () => { calls.push("hangup"); return {}; },
    shareScreen: async (display: string) => { calls.push("share"); displays.push(display); return { active: true, display, remoteControl: false, verified: true }; },
    stopSharing: async () => { calls.push("stop-sharing"); return { active: false, verified: true }; },
  };
  tools.setAvailable(true);
  assert.equal(definitions.size, 6);
  assert.deepEqual(active, ["read", "bash", "facetime_status", "facetime_answer", "facetime_hangup", "facetime_call", "facetime_share_screen", "facetime_stop_sharing"]);
  assert.ok([...definitions.values()].every(tool => tool.exposure === "direct"));
  const call = definitions.get("facetime_call");
  assert.deepEqual(call.parameters.required, ["reason"]);
  assert.equal(call.parameters.properties.to, undefined);
  await call.execute("t", { reason: "Report the verified test result." }, undefined);
  assert.deepEqual(calls, ["owner"]);
  assert.deepEqual(reasons, ["Report the verified test result."]);
  const status = await definitions.get("facetime_status").execute("s", {}, undefined);
  assert.equal(status.details.phase, "standby");
  const abort = new AbortController(); abort.abort();
  await assert.rejects(call.execute("t", { reason: "test" }, abort.signal), /cancelled/);
  const share = definitions.get("facetime_share_screen");
  const stop = definitions.get("facetime_stop_sharing");
  assert.deepEqual(share.parameters.required, ["display"]);
  assert.equal(share.parameters.properties.display.type, "string");
  assert.deepEqual(Object.keys(stop.parameters.properties), []);
  for (const tool of [share, stop]) {
    assert.match(tool.description, /explicit user request/);
    assert.match(tool.description, /entire.screen/);
    assert.match(tool.description, /remote control/);
    assert.match(tool.description, /[Nn]ever retry|retry after/);
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.annotations.idempotentHint, false);
    await assert.rejects(tool.execute("aborted", { display: "Studio Display" }, abort.signal), /cancelled/);
  }
  const sharing = await share.execute("share", { display: "Studio  DISPLAY" });
  assert.deepEqual(displays, ["Studio  DISPLAY"]);
  assert.deepEqual(sharing.details, { active: true, display: "Studio  DISPLAY", remoteControl: false, verified: true });
  assert.deepEqual(JSON.parse(sharing.content[0].text), sharing.details);
  assert.deepEqual((await stop.execute("stop", {})).details, { active: false, verified: true });
  mode = { ...mode, status: () => ({ enabled: false }) };
  for (const tool of [share, stop]) await assert.rejects(tool.execute("disabled", { display: "Studio Display" }), /require \/talk facetime/);
  mode = undefined;
  tools.setAvailable(false);
  assert.deepEqual(active, ["read", "bash"]);
  assert.ok([...definitions.values()].every(tool => tool.exposure === "hidden"));
  await assert.rejects(call.execute("stale", { reason: "test" }), /require \/talk facetime/);
  for (const tool of [share, stop]) await assert.rejects(tool.execute("stale", { display: "Studio Display" }), /require \/talk facetime/);
  assert.deepEqual(calls, ["owner", "share", "stop-sharing"]);
});

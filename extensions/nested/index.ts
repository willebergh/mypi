import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { announceExtension } from "../resource-status/protocol.ts";
import { registerNestedAgents } from "./agents.ts";
import { registerNestedMcp } from "./mcp.ts";
import { registerNestedSkills } from "./skills.ts";

/** One discovered extension; each resource keeps its existing lifecycle guards. */
export default function nested(pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    announceExtension(pi.events, { id: "nested", label: "nested" });
  });

  // Preserve the former entry points' alphabetical handler order. In particular,
  // an instruction guard must still block a mutation before MCP activation.
  registerNestedSkills(pi);
  registerNestedAgents(pi);
  registerNestedMcp(pi);
}

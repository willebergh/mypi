import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { announceExtension } from "../resource-status/protocol.ts";
import { loadPackageEnv } from "./config.ts";
import { registerScrapeTool } from "./tools/scrape.ts";

export default function webExtension(pi: ExtensionAPI) {
  loadPackageEnv();

  pi.on("session_start", async () => {
    announceExtension(pi.events, { id: "web", label: "web" });
  });

  registerScrapeTool(pi);
}

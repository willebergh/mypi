import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  OPENAI_USAGE_CHANGED_EVENT,
  announceExtension,
} from "../resource-status/protocol.ts";
import {
  OPENAI_CODEX_PROVIDER,
  OPENAI_USAGE_URL,
  accountIdFromToken,
  formatOpenAiUsageState,
  parseOpenAiUsage,
  type OpenAiUsageSnapshot,
  type OpenAiUsageState,
} from "./core.ts";

const POLL_INTERVAL_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;

async function fetchUsage(
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<OpenAiUsageSnapshot> {
  const accessToken = await ctx.modelRegistry.getApiKeyForProvider(
    OPENAI_CODEX_PROVIDER,
  );
  if (!accessToken) {
    throw new Error("not logged in to ChatGPT Codex");
  }

  const accountId = accountIdFromToken(accessToken);
  if (!accountId) throw new Error("account id missing from OpenAI token");

  const response = await fetch(OPENAI_USAGE_URL, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "ChatGPT-Account-Id": accountId,
      "User-Agent": "mypi-openai-usage",
      originator: "pi",
    },
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `request failed (${response.status}${response.statusText ? ` ${response.statusText}` : ""})`,
    );
  }

  return parseOpenAiUsage(await response.json());
}

function supportsUsage(ctx: ExtensionContext): boolean {
  return ctx.mode === "tui" && ctx.model?.provider === OPENAI_CODEX_PROVIDER;
}

export default function openAiUsage(pi: ExtensionAPI) {
  let state: OpenAiUsageState = { status: "inactive" };
  let activeContext: ExtensionContext | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let requestController: AbortController | undefined;
  let requestGeneration = 0;
  let requestInFlight: Promise<void> | undefined;

  const publish = (nextState: OpenAiUsageState) => {
    state = nextState;
    pi.events.emit(OPENAI_USAGE_CHANGED_EVENT, state);
  };

  const stopRequest = () => {
    requestGeneration += 1;
    requestController?.abort();
    requestController = undefined;
    requestInFlight = undefined;
  };

  const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
  };

  const refresh = async (
    ctx: ExtensionContext,
    options: { force?: boolean; notify?: boolean } = {},
  ): Promise<void> => {
    if (!supportsUsage(ctx)) {
      publish({ status: "inactive" });
      return;
    }
    if (requestInFlight && !options.force) return requestInFlight;
    if (options.force) stopRequest();

    if (state.status !== "ready") publish({ status: "loading" });
    const generation = ++requestGeneration;
    const controller = new AbortController();
    requestController = controller;
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const promise = fetchUsage(ctx, controller.signal)
      .then((snapshot) => {
        if (generation !== requestGeneration || controller.signal.aborted) return;
        const nextState: OpenAiUsageState = { status: "ready", snapshot };
        publish(nextState);
        if (options.notify) {
          ctx.ui.notify(formatOpenAiUsageState(nextState) ?? "OpenAI limits unavailable", "info");
        }
      })
      .catch((error) => {
        if (generation !== requestGeneration) return;
        const message = controller.signal.aborted
          ? "request timed out"
          : error instanceof Error
            ? error.message
            : String(error);
        const nextState: OpenAiUsageState = {
          status: "error",
          message,
          updatedAt: Date.now(),
        };
        publish(nextState);
        if (options.notify) ctx.ui.notify(message, "error");
      })
      .finally(() => {
        clearTimeout(timeout);
        if (generation === requestGeneration) {
          requestController = undefined;
          requestInFlight = undefined;
        }
      });

    requestInFlight = promise;
    return promise;
  };

  const synchronize = (ctx: ExtensionContext) => {
    activeContext = ctx;
    stopPolling();
    stopRequest();

    if (!supportsUsage(ctx)) {
      publish({ status: "inactive" });
      return;
    }

    void refresh(ctx);
    pollTimer = setInterval(() => {
      if (activeContext) void refresh(activeContext);
    }, POLL_INTERVAL_MS);
  };

  pi.on("session_start", async (_event, ctx) => {
    announceExtension(pi.events, {
      id: "openai-usage",
      label: "openai-usage",
    });
    synchronize(ctx);
  });

  pi.on("model_select", async (_event, ctx) => synchronize(ctx));

  pi.on("turn_end", async (_event, ctx) => {
    if (supportsUsage(ctx)) void refresh(ctx, { force: true });
  });

  pi.on("session_shutdown", async () => {
    stopPolling();
    stopRequest();
    activeContext = undefined;
    publish({ status: "inactive" });
  });

  pi.registerCommand("openai-usage", {
    description: "Show or refresh ChatGPT Codex subscription rate limits",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action && action !== "refresh" && action !== "show") {
        ctx.ui.notify("Usage: /openai-usage [show|refresh]", "error");
        return;
      }
      if (!supportsUsage(ctx)) {
        ctx.ui.notify("OpenAI subscription limits require an openai-codex model.", "warning");
        return;
      }
      await refresh(ctx, { force: action === "refresh", notify: true });
    },
  });
}

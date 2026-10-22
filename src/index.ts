/** OpenCode Discord Rich Presence plugin (terminal/TUI V1 API). */

import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import { DiscordRPCClient, type ActivityStatus } from "./discord.js";
import { getConfig, type PluginConfig } from "./config.js";

type LogLevel = "info" | "warn" | "error" | "debug";
type Logger = (message: string, level?: LogLevel) => void;

type SharedState = {
  rpcClient: DiscordRPCClient | null;
  currentModelName: string | null;
  currentProviderID: string | null;
  currentSessionName: string | null;
  currentStatus: ActivityStatus;
  currentSessionID: string | null;
  connected: Promise<boolean> | null;
  yielded: boolean;
  lastActivityAt: number;
  watchdog: ReturnType<typeof setInterval> | null;
};

const globalState = globalThis as { __discordRpcShared?: SharedState };
const shared: SharedState =
  globalState.__discordRpcShared ??
  (globalState.__discordRpcShared = {
    rpcClient: null,
    currentModelName: null,
    currentProviderID: null,
    currentSessionName: null,
    currentStatus: "idle",
    currentSessionID: null,
    connected: null,
    yielded: false,
    lastActivityAt: 0,
    watchdog: null,
  });

const YIELD_DEBOUNCE_MS = 2000;
const ACTIVITY_FREQUENCY_MS = 500;

function formatModelName(modelId: string | undefined): string {
  if (!modelId) return "OpenCode";
  return modelId.replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/-\d{8}$/, "");
}

function createLogger(client: PluginInput["client"]): Logger {
  return (message, level = "info") => {
    void client.app.log({ body: { service: "discord-rpc", level, message } }).catch(() => {
      console.log(`[discord-rpc] [${level}] ${message}`);
    });
  };
}

function markActivity(): void {
  shared.lastActivityAt = Date.now();
  shared.rpcClient?.markActivity();
  updatePresence();
}

function updatePresence(): void {
  if (!shared.rpcClient) return;
  shared.yielded = false;
  void shared.rpcClient.updatePresence({
    status: shared.currentStatus,
    modelName: shared.currentModelName || undefined,
    providerID: shared.currentProviderID || undefined,
    sessionName: shared.currentSessionName || undefined,
  });
}

function yieldToOtherRpc(): void {
  if (!shared.rpcClient || shared.yielded) return;
  shared.rpcClient.cancelPending();
  shared.yielded = true;
  void shared.rpcClient.clearPresence();
}

function startWatchdog(): void {
  if (shared.watchdog) return;
  shared.watchdog = setInterval(() => {
    if (!shared.rpcClient || shared.connected === null || shared.yielded || !shared.currentSessionID) return;
    if (Date.now() - shared.lastActivityAt >= YIELD_DEBOUNCE_MS) {
      shared.currentStatus = "idle";
      yieldToOtherRpc();
    }
  }, ACTIVITY_FREQUENCY_MS);
}

function ensureConnected(log: Logger): void {
  if (shared.rpcClient || shared.connected) return;
  shared.rpcClient = new DiscordRPCClient(log);
  shared.connected = shared.rpcClient.connect().then((connected) => {
    if (connected) {
      shared.rpcClient?.startSession(shared.currentSessionID ?? undefined);
      shared.currentStatus = "idle";
      startWatchdog();
    }
    return connected;
  });
}

function setModel(model: { modelID?: string; id?: string; providerID?: string } | undefined, log: Logger): void {
  if (!model) return;
  const id = model.modelID ?? model.id;
  if (id) {
    const name = formatModelName(id);
    if (name !== shared.currentModelName) {
      shared.currentModelName = name;
      log(`Model detected: ${name}`, "debug");
    }
  }
  if (model.providerID && model.providerID !== shared.currentProviderID) {
    shared.currentProviderID = model.providerID;
    log(`Provider detected: ${model.providerID}`, "debug");
  }
}

function ensureSession(sessionID: string | undefined, log: Logger): void {
  if (!sessionID || sessionID === shared.currentSessionID) return;
  shared.currentSessionID = sessionID;
  shared.rpcClient?.startSession(sessionID);
  log(`New session started: ${sessionID}`, "debug");
}

function updateSessionInfo(data: Record<string, unknown>, config: PluginConfig, log: Logger): void {
  const info = data.info && typeof data.info === "object" ? data.info as Record<string, unknown> : data;
  const sessionID = typeof info.id === "string" ? info.id : typeof info.sessionID === "string" ? info.sessionID : undefined;
  ensureSession(sessionID, log);
  if (!config.showSession) return;

  const title = typeof info.title === "string" ? info.title : undefined;
  const directory = typeof info.directory === "string" ? info.directory : undefined;
  const project = directory?.split(/[\\/]/).pop();
  const name = title && !title.startsWith("New session -")
    ? title
    : project && !["home", "diego", "root", "users", "user"].includes(project.toLowerCase())
      ? project
      : undefined;
  if (name && name !== shared.currentSessionName) {
    shared.currentSessionName = name;
    log(`Session name detected: ${name}`, "debug");
  }
}

function resetSession(): void {
  shared.currentStatus = "idle";
  shared.currentModelName = null;
  shared.currentProviderID = null;
  shared.currentSessionName = null;
  shared.currentSessionID = null;
  shared.yielded = true;
  shared.lastActivityAt = 0;
  shared.rpcClient?.cancelPending();
  void shared.rpcClient?.clearPresence();
}

function eventData(event: unknown): Record<string, unknown> {
  if (!event || typeof event !== "object") return {};
  const value = event as { properties?: unknown; data?: unknown };
  const data = value.data ?? value.properties;
  return data && typeof data === "object" ? data as Record<string, unknown> : {};
}

export const DiscordRPCPlugin: Plugin = async (ctx) => {
  const config = getConfig();
  if (!config.enabled) {
    console.log("[discord-rpc] Plugin disabled via configuration");
    return {};
  }

  const log = createLogger(ctx.client);
  ensureConnected(log);

  const hooks: Hooks = {
    "chat.message": async (input) => {
      setModel(input.model, log);
      shared.currentStatus = "thinking";
      markActivity();
    },
    "chat.params": async (input) => {
      setModel(input.model, log);
    },
    event: async ({ event }) => {
      if (!shared.rpcClient) return;
      const data = eventData(event);
      switch (event.type) {
        case "session.created":
        case "session.updated":
          updateSessionInfo(data, config, log);
          break;
        case "session.status": {
          const status = data.status && typeof data.status === "object" ? data.status as Record<string, unknown> : data;
          const statusType = status.type;
          if (statusType === "busy") {
            shared.currentStatus = "coding";
            markActivity();
          } else if (statusType === "idle") {
            shared.currentStatus = "waiting";
            yieldToOtherRpc();
          }
          break;
        }
        case "session.idle":
          shared.currentStatus = "idle";
          yieldToOtherRpc();
          break;
        case "session.deleted":
          resetSession();
          break;
        case "message.part.updated":
          shared.currentStatus = "thinking";
          markActivity();
          break;
      }
    },
    "tool.execute.before": async () => {
      shared.currentStatus = "coding";
      markActivity();
    },
    "tool.execute.after": async () => {
      shared.currentStatus = "thinking";
      markActivity();
    },
  };

  return hooks;
};

export default DiscordRPCPlugin;

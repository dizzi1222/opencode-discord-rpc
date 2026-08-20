/**
 * OpenCode Discord Rich Presence Plugin
 * 
 * Displays your OpenCode coding activity in Discord Rich Presence.
 * 
 * Features:
 * - Shows current model being used
 * - Displays session duration (elapsed time)
 * - Shows activity status (Coding/Idle/Thinking)
 * - Shows the current session/project name
 * - Button link to OpenCode.ai
 * 
 * Configuration via environment variables:
 * - OPENCODE_DISCORD_CLIENT_ID: Custom Discord Application ID
 * - OPENCODE_DISCORD_ENABLED: Set to "false" to disable
 * - OPENCODE_DISCORD_SHOW_SESSION: Set to "false" to hide the session name
 */

import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin";
import { DiscordRPCClient, type ActivityStatus } from "./discord.js";
import { getConfig } from "./config.js";

// Process-wide shared state. OpenCode registers EVERY function export as a
// plugin (see getLegacyPlugins in opencode's loader), so this module may be
// initialized more than once. A module-level singleton is NOT enough: two
// clients with the same clientId would fight on the same Discord IPC socket
// (presence stuck at the initial state, activity constantly overriding other
// apps like neovim). Keeping the client and all hook state on `globalThis`
// guarantees exactly ONE connection and ONE state per process.
type SharedState = {
  rpcClient: DiscordRPCClient | null;
  currentModelName: string | null;
  currentProviderID: string | null;
  currentSessionName: string | null;
  currentStatus: ActivityStatus;
  currentSessionID: string | null;
  connected: Promise<boolean> | null;
  /** True once we've cleared our activity to yield the line to presence.nvim. */
  yielded: boolean;
  /**
   * Wall-clock time of the LAST real opencode activity (chat/tool/stream).
   * The watchdog uses this to yield even when opencode never emits a clean
   * "idle" event (e.g. after pressing stop mid-response).
   */
  lastActivityAt: number;
  /** Watchdog interval handle (per process). */
  watchdog: ReturnType<typeof setInterval> | null;
};

const g = globalThis as { __discordRpcShared?: SharedState };
const shared: SharedState =
  g.__discordRpcShared ??
  (g.__discordRpcShared = {
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

/**
 * How long without real activity before handing the line to neovim. Debounced
 * so brief busy<->idle flaps during a session don't flicker Discord.
 */
const YIELD_DEBOUNCE_MS = 2000;
const ACTIVITY_FREQUENCY_MS = 500;

/**
 * Create a logging function that uses OpenCode's logging system
 */
function createLogger(client: PluginInput["client"]) {
  return async (message: string, level: "info" | "warn" | "error" | "debug" = "info") => {
    try {
      await client.app.log({
        body: {
          service: "discord-rpc",
          level,
          message,
        },
      });
    } catch {
      // Fallback to console if OpenCode logging fails
      console.log(`[discord-rpc] [${level}] ${message}`);
    }
  };
}

/**
 * Extract model display name from model ID
 * e.g., "gpt-4o-2024-08-06" -> "gpt-4o"
 * e.g., "claude-sonnet-4-20250514" -> "claude-sonnet-4"
 */
function formatModelName(modelId: string | undefined): string {
  if (!modelId) return "OpenCode";

  // Remove date suffixes (e.g., "-20250514", "-2024-08-06")
  let name = modelId.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  name = name.replace(/-\d{8}$/, "");

  return name;
}

/**
 * Mark real opencode activity (chat message, tool execution, streaming).
 * Updates the RPC client's active time tracking and triggers presence update.
 */
function markActivity(): void {
  shared.lastActivityAt = Date.now();
  if (shared.rpcClient) {
    shared.rpcClient.markActivity();
  }
  updatePresence();
}

/**
 * Update the Discord presence with current state.
 *
 * NOTE: This is intentionally fire-and-forget. It must NEVER block opencode's
 * hook pipeline, otherwise a slow/unresponsive Discord connection would hang
 * tool execution. Errors are caught inside the RPC client.
 */
function updatePresence(): void {
  if (!shared.rpcClient) return;

  // Any active update takes the line back from neovim.
  shared.yielded = false;

  void shared.rpcClient.updatePresence({
    status: shared.currentStatus,
    modelName: shared.currentModelName || undefined,
    providerID: shared.currentProviderID || undefined,
    sessionName: shared.currentSessionName || undefined,
  });
}

/**
 * Hand the Discord activity line over to presence.nvim. We publish under our
 * own client id, so clearing our activity makes neovim's auto-updating card
 * the only visible one.
 */
function yieldToNeovim(): void {
  if (!shared.rpcClient) return;
  if (shared.yielded) return;

  shared.rpcClient.cancelPending();
  shared.yielded = true;
  void shared.rpcClient.clearPresence();
}

/**
 * Watchdog: if opencode hasn't had REAL activity for YIELD_DEBOUNCE_MS, hand
 * the line to neovim even if opencode never emitted a clean "idle" event
 * (e.g. session stays active but the user pressed stop mid-response).
 */
function startWatchdog(): void {
  if (shared.watchdog) return;

  shared.watchdog = setInterval(() => {
    if (!shared.rpcClient) return;
    if (shared.connected === null) return;
    if (shared.yielded) return;

    // Only yield when there is an active session at all.
    if (!shared.currentSessionID) return;

    const idleMs = Date.now() - shared.lastActivityAt;
    if (idleMs >= YIELD_DEBOUNCE_MS) {
      shared.currentStatus = "idle";
      yieldToNeovim();
    }
  }, ACTIVITY_FREQUENCY_MS);
}

/**
 * Connect to Discord exactly once per process. Subsequent plugin
 * initializations (openCode may call this factory multiple times) reuse the
 * same client and connection.
 */
function ensureConnected(log: (message: string, level?: "info" | "warn" | "error" | "debug") => void): void {
  if (shared.rpcClient) return;
  if (shared.connected) return;

  shared.rpcClient = new DiscordRPCClient(log);

  shared.connected = shared.rpcClient.connect().then((connected) => {
    if (connected) {
      shared.rpcClient?.startSession(shared.currentSessionID ?? undefined);
      shared.currentStatus = "idle";
      startWatchdog();
      // Do NOT publish "idle" on boot: if presence.nvim is running it should
      // own the line until opencode actually does something.
    }
    return connected;
  });
}

/**
 * Main plugin export for OpenCode
 */
export const DiscordRPCPlugin: Plugin = async (ctx) => {
  const config = getConfig();

  if (!config.enabled) {
    console.log("[discord-rpc] Plugin disabled via configuration");
    return {};
  }

  // Create logger using OpenCode's logging system
  const log = createLogger(ctx.client);

  // Initialize the RPC client (idempotent across repeated initializations)
  ensureConnected((msg, level) => {
    void log(msg, level);
  });

  // Return event hooks
  const hooks: Hooks = {
    // Hook into chat.message to get the model being used
    "chat.message": async (input) => {
      if (!shared.rpcClient) return;

      // Extract model info from the chat message
      if (input.model?.modelID) {
        const newModel = formatModelName(input.model.modelID);
        if (newModel !== shared.currentModelName) {
          shared.currentModelName = newModel;
          log(`Model detected: ${shared.currentModelName}`, "debug");
        }
      }

      // Extract provider info from the chat message
      if (input.model?.providerID) {
        const newProvider = input.model.providerID;
        if (newProvider !== shared.currentProviderID) {
          shared.currentProviderID = newProvider;
          log(`Provider detected: ${shared.currentProviderID}`, "debug");
        }
      }

      // We're actively chatting, so set status to thinking
      shared.currentStatus = "thinking";
      markActivity();
    },

    // Hook into chat.params for additional model detection
    "chat.params": async (input) => {
      if (!shared.rpcClient) return;

      // Extract model from params
      if (input.model?.id) {
        const newModel = formatModelName(input.model.id);
        if (newModel !== shared.currentModelName) {
          shared.currentModelName = newModel;
          log(`Model from params: ${shared.currentModelName}`, "debug");
        }
      }

      // Extract provider from params
      if (input.model?.providerID) {
        const newProvider = input.model.providerID;
        if (newProvider !== shared.currentProviderID) {
          shared.currentProviderID = newProvider;
          log(`Provider from params: ${shared.currentProviderID}`, "debug");
        }
      }
    },

    event: async ({ event }) => {
      if (!shared.rpcClient) return;

      switch (event.type) {
        case "session.created":
        case "session.updated": {
          const props = event.properties as {
            info?: { id?: string; directory?: string; title?: string; slug?: string };
          } | undefined;

          if (config.showSession && props?.info) {
            // Prefer the auto-generated session title, falling back to the
            // project folder name. Skip "New session - <slug>" titles and their
            // slugs (e.g., "tidy-wolf") — they're not meaningful.
            const { title, slug, directory } = props.info;
            const isNewSession = title?.startsWith("New session -");
            const name = title && !isNewSession
              ? title
              : (directory ? directory.split(/[\\/]/).pop() : undefined);

            if (name && name !== shared.currentSessionName) {
              shared.currentSessionName = name;
              log(`Session name detected: ${shared.currentSessionName}`, "debug");
            }
          }

          // Reset the elapsed timer ONLY when the session actually changes.
          // session.updated fires on every message/token, and resetting there
          // would keep the timer pinned at 0:00. A stable start timestamp also
          // keeps the activity quiet so neovim/etc. can coexist.
          const sessionID = props?.info?.id;
          if (sessionID && sessionID !== shared.currentSessionID) {
            shared.currentSessionID = sessionID;
            shared.rpcClient.startSession(sessionID);
            log(`New session started: ${sessionID}`, "debug");
          }

          // NOTE: session.updated fires on EVERY message/token, so we must NOT
          // touch the status or call updatePresence() here — doing so would
          // cancel any pending yield (yieldToNeovim) on every event and leave
          // opencode's presence stuck on screen forever. Status is driven only
          // by the real transitions: session.status busy/idle, chat.message,
          // message.part.updated and tool.execute.*.
          break;
        }

        case "session.status": {
          // Status changed (busy/idle)
          const props = event.properties as { status?: { type: string } } | undefined;
          const statusType = props?.status?.type;

          if (statusType === "busy") {
            shared.currentStatus = "coding";
            markActivity();
          } else if (statusType === "idle") {
            shared.currentStatus = "waiting";
            yieldToNeovim();
          }
          break;
        }

        case "session.idle": {
          // Session went idle
          shared.currentStatus = "idle";
          yieldToNeovim();
          break;
        }

        case "session.deleted": {
          // Session ended: release the line immediately.
          shared.currentStatus = "idle";
          shared.currentModelName = null;
          shared.currentProviderID = null;
          shared.currentSessionName = null;
          shared.currentSessionID = null;
          shared.yielded = true;
          shared.lastActivityAt = 0;
          shared.rpcClient.cancelPending();
          void shared.rpcClient.clearPresence();
          break;
        }

        case "message.part.updated": {
          // AI is generating a response
          shared.currentStatus = "thinking";
          markActivity();
          break;
        }
      }
    },

    "tool.execute.before": async () => {
      // Tool is about to execute
      if (!shared.rpcClient) return;
      shared.currentStatus = "coding";
      markActivity();
    },

    "tool.execute.after": async () => {
      // Tool finished executing
      if (!shared.rpcClient) return;
      shared.currentStatus = "thinking";
      markActivity();
    },
  };

  return hooks;
};

// Default export for convenience
export default DiscordRPCPlugin;
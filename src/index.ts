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
  currentSessionName: string | null;
  currentStatus: ActivityStatus;
  currentSessionID: string | null;
  connected: Promise<boolean> | null;
};

const g = globalThis as { __discordRpcShared?: SharedState };
const shared: SharedState =
  g.__discordRpcShared ??
  (g.__discordRpcShared = {
    rpcClient: null,
    currentModelName: null,
    currentSessionName: null,
    currentStatus: "idle",
    currentSessionID: null,
    connected: null,
  });

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
 * Update the Discord presence with current state.
 *
 * NOTE: This is intentionally fire-and-forget. It must NEVER block opencode's
 * hook pipeline, otherwise a slow/unresponsive Discord connection would hang
 * tool execution. Errors are caught inside the RPC client.
 */
function updatePresence(): void {
  if (!shared.rpcClient) return;

  void shared.rpcClient.updatePresence({
    status: shared.currentStatus,
    modelName: shared.currentModelName || undefined,
    sessionName: shared.currentSessionName || undefined,
  });
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
      shared.rpcClient?.startSession();
      shared.currentStatus = "idle";
      updatePresence();
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
          updatePresence();
        }
      }

      // We're actively chatting, so set status to thinking
      if (shared.currentStatus !== "thinking") {
        shared.currentStatus = "thinking";
        updatePresence();
      }
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
          updatePresence();
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
            // human-readable slug, then to the project folder name.
            const { title, slug, directory } = props.info;
            const name = title && !title.startsWith("New session -")
              ? title
              : slug || (directory ? directory.split(/[\\/]/).pop() : undefined);

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
            shared.rpcClient.startSession();
            log(`New session started: ${sessionID}`, "debug");
          }

          shared.currentStatus = "coding";
          updatePresence();
          break;
        }

        case "session.status": {
          // Status changed (busy/idle)
          const props = event.properties as { status?: { type: string } } | undefined;
          const statusType = props?.status?.type;

          if (statusType === "busy") {
            shared.currentStatus = "coding";
          } else if (statusType === "idle") {
            shared.currentStatus = "waiting";
          }

          updatePresence();
          break;
        }

        case "session.idle": {
          // Session went idle
          shared.currentStatus = "idle";
          updatePresence();
          break;
        }

        case "session.deleted": {
          // Session ended
          shared.currentStatus = "idle";
          shared.currentModelName = null;
          shared.currentSessionName = null;
          shared.currentSessionID = null;
          shared.rpcClient.clearPresence();
          break;
        }

        case "message.part.updated": {
          // AI is generating a response
          if (shared.currentStatus !== "thinking") {
            shared.currentStatus = "thinking";
            updatePresence();
          }
          break;
        }
      }
    },

    "tool.execute.before": async () => {
      // Tool is about to execute
      if (shared.rpcClient && shared.currentStatus !== "coding") {
        shared.currentStatus = "coding";
        updatePresence();
      }
    },

    "tool.execute.after": async () => {
      // Tool finished executing
      if (shared.rpcClient && shared.currentStatus !== "thinking") {
        shared.currentStatus = "thinking";
        updatePresence();
      }
    },
  };

  return hooks;
};

// Default export for convenience
export default DiscordRPCPlugin;
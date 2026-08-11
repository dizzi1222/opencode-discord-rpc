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

// Singleton RPC client instance
let rpcClient: DiscordRPCClient | null = null;
let currentModelName: string | null = null;
let currentSessionName: string | null = null;
let currentStatus: ActivityStatus = "idle";

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
  if (!rpcClient) return;

  void rpcClient.updatePresence({
    status: currentStatus,
    modelName: currentModelName || undefined,
    sessionName: currentSessionName || undefined,
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

  // Initialize the RPC client
  rpcClient = new DiscordRPCClient((msg, level) => {
    void log(msg, level);
  });

  // Schedule initial connection without blocking plugin startup
  log("Initializing Discord Rich Presence...", "info");
  void rpcClient.connect().then((connected) => {
    if (connected) {
      rpcClient?.startSession();
      currentStatus = "idle";
      updatePresence();
    }
  });

  // Return event hooks
  const hooks: Hooks = {
    // Hook into chat.message to get the model being used
    "chat.message": async (input) => {
      if (!rpcClient) return;

      // Extract model info from the chat message
      if (input.model?.modelID) {
        const newModel = formatModelName(input.model.modelID);
        if (newModel !== currentModelName) {
          currentModelName = newModel;
          log(`Model detected: ${currentModelName}`, "debug");
          updatePresence();
        }
      }

      // We're actively chatting, so set status to thinking
      if (currentStatus !== "thinking") {
        currentStatus = "thinking";
        updatePresence();
      }
    },

    // Hook into chat.params for additional model detection
    "chat.params": async (input) => {
      if (!rpcClient) return;

      // Extract model from params
      if (input.model?.id) {
        const newModel = formatModelName(input.model.id);
        if (newModel !== currentModelName) {
          currentModelName = newModel;
          log(`Model from params: ${currentModelName}`, "debug");
          updatePresence();
        }
      }
    },

    event: async ({ event }) => {
      if (!rpcClient) return;

      switch (event.type) {
        case "session.created":
        case "session.updated": {
          const props = event.properties as {
            info?: { directory?: string; title?: string };
          } | undefined;

          if (config.showSession && props?.info?.directory) {
            // Show the project folder name, not the full path
            const directory = props.info.directory.replace(/\/+$/, "");
            const project = directory.split(/[\\/]/).pop();
            if (project && project !== currentSessionName) {
              currentSessionName = project;
              log(`Session name detected: ${currentSessionName}`, "debug");
            }
          }

          // New session started - reset timer
          rpcClient.startSession();
          currentStatus = "coding";
          updatePresence();
          break;
        }

        case "session.status": {
          // Status changed (busy/idle)
          const props = event.properties as { status?: { type: string } } | undefined;
          const statusType = props?.status?.type;

          if (statusType === "busy") {
            currentStatus = "coding";
          } else if (statusType === "idle") {
            currentStatus = "waiting";
          }

          updatePresence();
          break;
        }

        case "session.idle": {
          // Session went idle
          currentStatus = "idle";
          updatePresence();
          break;
        }

        case "session.deleted": {
          // Session ended
          currentStatus = "idle";
          currentModelName = null;
          currentSessionName = null;
          void rpcClient.clearPresence();
          break;
        }

        case "message.part.updated": {
          // AI is generating a response
          if (currentStatus !== "thinking") {
            currentStatus = "thinking";
            updatePresence();
          }
          break;
        }
      }
    },

    "tool.execute.before": async () => {
      // Tool is about to execute
      if (rpcClient && currentStatus !== "coding") {
        currentStatus = "coding";
        updatePresence();
      }
    },

    "tool.execute.after": async () => {
      // Tool finished executing
      if (rpcClient && currentStatus !== "thinking") {
        currentStatus = "thinking";
        updatePresence();
      }
    },
  };

  return hooks;
};

// Default export for convenience
export default DiscordRPCPlugin;

// Re-export config utilities for users who want to check configuration
export { getConfig } from "./config.js";
export type { PluginConfig } from "./config.js";
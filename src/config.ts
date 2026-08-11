/**
 * Configuration for the Discord Rich Presence plugin
 */

// Default Discord Application Client ID for OpenCode
// Users can override this with their own Application ID
export const DEFAULT_CLIENT_ID = "1462270555586822206";

export interface PluginConfig {
  /** Discord Application Client ID */
  clientId: string;
  /** Whether the plugin is enabled */
  enabled: boolean;
  /** Whether to show the session/project name */
  showSession: boolean;
  /** Retry connection interval in ms */
  retryInterval: number;
  /** Maximum retry attempts before giving up */
  maxRetries: number;
}

/**
 * Get plugin configuration from environment variables
 */
export function getConfig(): PluginConfig {
  return {
    clientId: process.env.OPENCODE_DISCORD_CLIENT_ID || DEFAULT_CLIENT_ID,
    enabled: process.env.OPENCODE_DISCORD_ENABLED !== "false",
    showSession: process.env.OPENCODE_DISCORD_SHOW_SESSION !== "false",
    retryInterval: parseInt(process.env.OPENCODE_DISCORD_RETRY_INTERVAL || "15000", 10),
    maxRetries: parseInt(process.env.OPENCODE_DISCORD_MAX_RETRIES || "5", 10),
  };
}

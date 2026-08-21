/**
 * Configuration for the Discord Rich Presence plugin
 */

// Default Discord Application Client ID — the "opencode" app (1462).
//
// Keep this SEPARATE from cord.nvim's client id (7932 = "Neovim"):
// each app publishes under its own identity so Discord shows the correct
// title/logo for each. Alternation works via clear-on-idle: opencode yields
// the screen by removing its own activity when idle, never by reusing the
// Neovim application id. Override with OPENCODE_DISCORD_CLIENT_ID if needed.
export const DEFAULT_CLIENT_ID = "1462270555586822206";

export interface PluginConfig {
  /** Discord Application Client ID */
  clientId: string;
  /** Whether the plugin is enabled */
  enabled: boolean;
  /** Whether to show the session/project name */
  showSession: boolean;
  /** Whether to show the provider name */
  showProvider: boolean;
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
    showProvider: process.env.OPENCODE_DISCORD_SHOW_PROVIDER !== "false",
    retryInterval: parseInt(process.env.OPENCODE_DISCORD_RETRY_INTERVAL || "15000", 10),
    maxRetries: parseInt(process.env.OPENCODE_DISCORD_MAX_RETRIES || "5", 10),
  };
}

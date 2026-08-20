/**
 * Discord RPC client wrapper with auto-reconnect functionality
 */

import { Client } from "@xhayper/discord-rpc";
import type { SetActivity } from "@xhayper/discord-rpc";
import { getConfig, type PluginConfig } from "./config.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type ActivityStatus = "coding" | "idle" | "thinking" | "waiting";

export interface PresenceData {
  status: ActivityStatus;
  modelName?: string;
  providerID?: string;
  sessionName?: string;
  startTimestamp?: Date;
}

const PRESENCE_TIMEOUT_MS = 5000;
const UPDATE_DEBOUNCE_MS = 1000;

/**
 * Persisted session active time so the elapsed timer survives reconnects
 * (Discord restarts, opencode reloads) but ONLY counts time when opencode
 * is actually running. Keyed by session id.
 */
const ACTIVE_TIME_FILE = join(homedir(), ".cache", "opencode-discord-rpc", "session-active-time");
// Legacy file (wall-clock start timestamps) — used for one-time migration
const LEGACY_START_FILE = join(homedir(), ".cache", "opencode-discord-rpc", "session-start");

interface PersistedActiveTime {
  accumulatedMs: number;
  lastActiveAt: number;
}

function loadPersistedActiveTime(sessionId: string): PersistedActiveTime | null {
  try {
    const raw = readFileSync(ACTIVE_TIME_FILE, "utf8").trim();
    const line = raw.split("\n").find((l) => l.startsWith(`${sessionId} `));
    if (!line) return null;
    const parts = line.split(" ");
    const accumulatedMs = Number(parts[1]);
    const lastActiveAt = Number(parts[2]);
    if (!Number.isFinite(accumulatedMs) || !Number.isFinite(lastActiveAt)) return null;
    return { accumulatedMs, lastActiveAt };
  } catch {
    // Try legacy migration
    return migrateLegacyStartTime(sessionId);
  }
}

function migrateLegacyStartTime(sessionId: string): PersistedActiveTime | null {
  try {
    const raw = readFileSync(LEGACY_START_FILE, "utf8").trim();
    const line = raw.split("\n").find((l) => l.startsWith(`${sessionId} `));
    if (!line) return null;
    const epoch = Number(line.split(" ")[1]);
    if (!Number.isFinite(epoch)) return null;

    // Calculate wall-clock elapsed since that start, use as initial accumulated time
    // This is an approximation (includes closed time), but preserves history
    const accumulatedMs = Date.now() - epoch;
    if (accumulatedMs < 0 || accumulatedMs > 365 * 24 * 60 * 60 * 1000) return null; // Sanity check

    return { accumulatedMs, lastActiveAt: Date.now() };
  } catch {
    return null;
  }
}

function persistActiveTime(sessionId: string, data: PersistedActiveTime): void {
  try {
    mkdirSync(dirname(ACTIVE_TIME_FILE), { recursive: true });
    const lines = (readFileSync(ACTIVE_TIME_FILE, "utf8").trim() || "").split("\n")
      .filter((l) => l && !l.startsWith(`${sessionId} `))
      .slice(-4);
    lines.push(`${sessionId} ${data.accumulatedMs} ${data.lastActiveAt}`);
    writeFileSync(ACTIVE_TIME_FILE, lines.join("\n") + "\n");
  } catch {
    // Persistence is best-effort; a failed write must not break presence.
  }
}

export class DiscordRPCClient {
  private client: Client | null = null;
  private config: PluginConfig;
  private isConnected = false;
  private isConnecting = false;
  private retryCount = 0;
  private retryTimeout: ReturnType<typeof setTimeout> | null = null;
  private currentPresence: PresenceData | null = null;
  private sessionStartTime: Date | null = null;
  private accumulatedActiveMs = 0;
  private lastActiveAt = 0;
  private currentSessionId: string | null = null;
  private log: (message: string, level?: "info" | "warn" | "error" | "debug") => void;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSentKey: string | null = null;

  constructor(
    log?: (message: string, level?: "info" | "warn" | "error" | "debug") => void
  ) {
    this.config = getConfig();
    this.log = log || ((msg, level = "info") => console.log(`[discord-rpc] [${level}] ${msg}`));
  }

  /**
   * Initialize and connect to Discord
   */
  async connect(): Promise<boolean> {
    if (!this.config.enabled) {
      this.log("Discord RPC is disabled via configuration", "info");
      return false;
    }

    if (this.isConnected || this.isConnecting) {
      return this.isConnected;
    }

    this.isConnecting = true;

    try {
      this.client = new Client({
        clientId: this.config.clientId,
      });

      // Set up event handlers
      this.client.on("ready", () => {
        this.isConnected = true;
        this.isConnecting = false;
        this.retryCount = 0;
        this.log("Connected to Discord", "info");
        
        // Force a resend after (re)connect: Discord may have cleared the
        // activity while we were offline.
        this.lastSentKey = null;

        // Restore presence if we had one
        if (this.currentPresence) {
          this.updatePresence(this.currentPresence);
        }
      });

      this.client.on("disconnected", () => {
        this.isConnected = false;
        this.log("Disconnected from Discord", "warn");
        this.scheduleReconnect();
      });

      await this.client.login();
      return true;
    } catch (error) {
      this.isConnecting = false;
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Don't spam logs for common "Discord not running" errors
      if (errorMessage.includes("ENOENT") || errorMessage.includes("Could not connect")) {
        this.log("Discord is not running or not accessible", "debug");
      } else {
        this.log(`Failed to connect to Discord: ${errorMessage}`, "warn");
      }
      
      this.scheduleReconnect();
      return false;
    }
  }

  /**
   * Schedule a reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
    }

    if (this.retryCount >= this.config.maxRetries) {
      this.log(`Max retry attempts (${this.config.maxRetries}) reached. Giving up.`, "warn");
      return;
    }

    this.retryCount++;
    this.log(`Scheduling reconnect attempt ${this.retryCount}/${this.config.maxRetries} in ${this.config.retryInterval / 1000}s`, "debug");

    this.retryTimeout = setTimeout(() => {
      this.connect();
    }, this.config.retryInterval);
  }

  /**
   * Update the Discord Rich Presence
   */
  async updatePresence(data: PresenceData): Promise<void> {
    this.currentPresence = data;

    if (!this.isConnected || !this.client?.user) {
      return;
    }

    // Debounce: coalesce rapid status flips (coding/thinking per tool call)
    // into a single Discord update. This keeps opencode quiet so other RPC
    // apps (neovim, etc.) can coexist instead of being flooded out.
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      void this.flushPresence();
    }, UPDATE_DEBOUNCE_MS);
  }

  private async flushPresence(): Promise<void> {
    this.debounceTimer = null;

    if (!this.isConnected || !this.client?.user) {
      return;
    }

    const data = this.currentPresence;
    if (!data) {
      return;
    }

    const config = getConfig();
    const statusText = this.getStatusText(data.status);
    const providerName = config.showProvider ? this.getProviderName(data.providerID) : null;

    const details = data.sessionName
      ? `${data.sessionName}`
      : data.modelName
        ? `Using ${data.modelName}`
        : "Using OpenCode";

    let state = statusText;
    if (data.modelName && providerName) {
      state = `${providerName} ${data.modelName} • ${statusText}`;
    } else if (data.modelName) {
      state = `${data.modelName} • ${statusText}`;
    }

    const start = this.sessionStartTime?.toISOString() ?? "";

    // Skip the round-trip if nothing observable changed. Timer is NOT part of
    // the key on purpose: it must never reset on status flips.
    const key = `${details}|${state}|${start}`;
    if (key === this.lastSentKey) {
      return;
    }
    this.lastSentKey = key;

    const activity: SetActivity = {
      details,
      state,
      largeImageKey: "opencode_rp_large_dark_1024",
      largeImageText: "OpenCode - AI Coding Assistant",
      smallImageKey: "opencode_icon_tight_dark_1024",
      smallImageText: statusText,
      buttons: [
        {
          label: "Visit OpenCode.ai",
          url: "https://opencode.ai",
        },
      ],
    };

    // Set start timestamp for elapsed time display
    if (this.sessionStartTime) {
      activity.startTimestamp = this.sessionStartTime;
    }

    try {
      await withTimeout(this.client.user.setActivity(activity), PRESENCE_TIMEOUT_MS);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log(`Failed to update presence: ${errorMessage !== "Timeout" ? errorMessage : "timeout - Discord not responding"}`, "error");
    }
  }

  /**
   * Start a new session (resets the timer). The timer is persisted keyed by
   * session id, so reconnects/alternations don't reset the elapsed display.
   * Only counts active time when opencode is running.
   */
  startSession(sessionId?: string): void {
    if (sessionId) {
      this.currentSessionId = sessionId;
      const persisted = loadPersistedActiveTime(sessionId);
      if (persisted) {
        this.accumulatedActiveMs = persisted.accumulatedMs;
        // Calculate effective start time for Discord display (now - accumulated active time)
        this.sessionStartTime = new Date(Date.now() - this.accumulatedActiveMs);
        this.lastActiveAt = Date.now(); // Start fresh tracking from now
        this.lastSentKey = null;
        this.log(`Session continued, active time: ${this.formatDuration(this.accumulatedActiveMs)} (${sessionId})`, "debug");
        return;
      }
      // New session
      this.accumulatedActiveMs = 0;
      this.sessionStartTime = new Date();
      this.lastActiveAt = Date.now();
      this.persistCurrentState();
      this.lastSentKey = null;
      this.log(`Session started, timer reset (${sessionId})`, "debug");
      return;
    }

    // Legacy call without session id: keep whatever we have.
    if (!this.sessionStartTime) {
      this.sessionStartTime = new Date();
      this.lastActiveAt = Date.now();
    }
    this.lastSentKey = null;
    this.log("Session timer ensured", "debug");
  }

  /**
   * Mark activity - updates accumulated active time.
   * Call this whenever there's real user/AI activity.
   */
  markActivity(): void {
    const now = Date.now();
    if (this.lastActiveAt > 0) {
      this.accumulatedActiveMs += now - this.lastActiveAt;
    }
    this.lastActiveAt = now;
    // Update sessionStartTime for Discord display (now - accumulated)
    this.sessionStartTime = new Date(now - this.accumulatedActiveMs);
    this.lastSentKey = null; // Force presence update
    this.persistCurrentState();
  }

  private persistCurrentState(): void {
    if (this.currentSessionId) {
      persistActiveTime(this.currentSessionId, {
        accumulatedMs: this.accumulatedActiveMs,
        lastActiveAt: this.lastActiveAt,
      });
    }
  }

  private formatDuration(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  /**
   * Get human-readable status text
   */
  private getStatusText(status: ActivityStatus): string {
    switch (status) {
      case "coding":
        return "Coding...";
      case "idle":
        return "Idle";
      case "thinking":
        return "Thinking...";
      case "waiting":
        return "Waiting for input...";
      default:
        return "Using OpenCode";
    }
  }

  /**
   * Get human-readable provider name from provider ID
   */
  private getProviderName(providerID: string | undefined): string | null {
    if (!providerID) return null;

    const providerMap: Record<string, string> = {
      openai: "OpenAI",
      anthropic: "Anthropic",
      google: "Google",
      openrouter: "OpenRouter",
      groq: "Groq",
      copilot: "GitHub Copilot",
      ollama: "Ollama",
      perplexity: "Perplexity",
      together: "Together AI",
      fireworks: "Fireworks AI",
      deepseek: "DeepSeek",
      mistral: "Mistral",
      cohere: "Cohere",
      vertex: "Vertex AI",
      bedrock: "AWS Bedrock",
      azure: "Azure OpenAI",
      cloudflare: "Cloudflare Workers AI",
      xai: "xAI",
    };

    return providerMap[providerID.toLowerCase()] ?? providerID;
  }

  /**
   * Drop any pending (debounced) SET so a stale update can't re-publish the
   * activity after we clear it. Used when yielding the line to another client
   * sharing the same client id (e.g. presence.nvim).
   */
  cancelPending(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.lastSentKey = null;
    this.currentPresence = null;
  }

  /**
   * Clear the presence
   */
  async clearPresence(): Promise<void> {
    if (!this.isConnected || !this.client?.user) {
      return;
    }

    try {
      await this.client.user.clearActivity();
      this.currentPresence = null;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log(`Failed to clear presence: ${errorMessage}`, "error");
    }
  }

  /**
   * Disconnect from Discord
   */
  async disconnect(): Promise<void> {
    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
      this.retryTimeout = null;
    }

    if (this.client) {
      try {
        await this.clearPresence();
        this.client.destroy();
      } catch {
        // Ignore errors during cleanup
      }
      this.client = null;
    }

    this.isConnected = false;
    this.isConnecting = false;
    this.log("Disconnected from Discord RPC", "info");
  }

  /**
   * Check if connected to Discord
   */
  get connected(): boolean {
    return this.isConnected;
  }
}

/**
 * Resolve a promise or reject with "Timeout" after the given milliseconds.
 * Prevents `setActivity` from hanging forever when Discord/Vesktop is unresponsive.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

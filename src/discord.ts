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
  sessionName?: string;
  startTimestamp?: Date;
}

const PRESENCE_TIMEOUT_MS = 5000;
const UPDATE_DEBOUNCE_MS = 1000;

/**
 * Persisted session start so the elapsed timer survives reconnects (Discord
 * restarts, opencode reloads). Keyed by session id: the timer only resets when
 * the actual session changes.
 */
const START_FILE = join(homedir(), ".cache", "opencode-discord-rpc", "session-start");

function loadPersistedStart(sessionId: string): Date | null {
  try {
    const raw = readFileSync(START_FILE, "utf8").trim();
    const line = raw.split("\n").find((l) => l.startsWith(`${sessionId} `));
    if (!line) return null;
    const epoch = Number(line.split(" ")[1]);
    return Number.isFinite(epoch) ? new Date(epoch) : null;
  } catch {
    return null;
  }
}

function persistStart(sessionId: string, date: Date): void {
  try {
    mkdirSync(dirname(START_FILE), { recursive: true });
    // Keep a tiny history (last 5) instead of a single line, so a previous
    // session's timestamp never leaks into a new one.
    const lines = (readFileSync(START_FILE, "utf8").trim() || "").split("\n")
      .filter((l) => l && !l.startsWith(`${sessionId} `))
      .slice(-4);
    lines.push(`${sessionId} ${date.getTime()}`);
    writeFileSync(START_FILE, lines.join("\n") + "\n");
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

    const statusText = this.getStatusText(data.status);
    const details = data.sessionName
      ? `${data.sessionName}`
      : data.modelName
        ? `Using ${data.modelName}`
        : "Using OpenCode";
    const state = data.modelName
      ? `${data.modelName} • ${statusText}`
      : statusText;
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
   */
  startSession(sessionId?: string): void {
    if (sessionId) {
      const persisted = loadPersistedStart(sessionId);
      if (persisted) {
        this.sessionStartTime = persisted;
        this.lastSentKey = null;
        this.log(`Session continued, timer kept (${sessionId})`, "debug");
        return;
      }
      this.sessionStartTime = new Date();
      persistStart(sessionId, this.sessionStartTime);
      this.lastSentKey = null;
      this.log(`Session started, timer reset (${sessionId})`, "debug");
      return;
    }

    // Legacy call without session id: keep whatever we have.
    if (!this.sessionStartTime) {
      this.sessionStartTime = new Date();
    }
    this.lastSentKey = null;
    this.log("Session timer ensured", "debug");
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

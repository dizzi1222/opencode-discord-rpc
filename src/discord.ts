/**
 * Discord RPC client wrapper with auto-reconnect functionality
 */

import { Client } from "@xhayper/discord-rpc";
import type { SetActivity } from "@xhayper/discord-rpc";
import { getConfig, type PluginConfig } from "./config.js";

export type ActivityStatus = "coding" | "idle" | "thinking" | "waiting";

export interface PresenceData {
  status: ActivityStatus;
  modelName?: string;
  sessionName?: string;
  startTimestamp?: Date;
}

const PRESENCE_TIMEOUT_MS = 5000;

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

    const statusText = this.getStatusText(data.status);
    const details = data.sessionName
      ? `${data.sessionName}`
      : data.modelName
        ? `Using ${data.modelName}`
        : "Using OpenCode";
    const state = data.modelName
      ? `${data.modelName} • ${statusText}`
      : statusText;

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
   * Start a new session (resets the timer)
   */
  startSession(): void {
    this.sessionStartTime = new Date();
    this.log("Session started, timer reset", "debug");
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

import * as vscode from "vscode";
import { Logger } from "./logger";

/**
 * Monitors network connectivity by periodically probing known endpoints.
 *
 * When a network disruption is detected and then connectivity recovers,
 * listeners are notified so the retry engine can submit a follow-up prompt
 * in the same conversation thread.
 *
 * Key insight: Chat panel errors like "net::ERR_NETWORK_CHANGED" are invisible
 * to the extension API. The only way to detect them is to independently monitor
 * network health and infer that active chat requests likely failed during an outage.
 * Calling the retry command when there's no error to retry is a safe no-op.
 */

/**
 * Endpoints to probe, in priority order. We only need one to succeed.
 * These are chosen because they're the backends Copilot actually talks to.
 */
const PROBE_ENDPOINTS = [
  "https://api.github.com",
  "https://copilot-proxy.githubusercontent.com",
  "https://api.githubcopilot.com",
];

/** How quickly we poll when network is down (want fast recovery detection). */
const FAST_POLL_INTERVAL_MS = 2000;
/** Normal polling interval when network is healthy. */
const NORMAL_POLL_INTERVAL_MS = 10_000;
/** Timeout for each probe request. */
const PROBE_TIMEOUT_MS = 5000;
/**
 * Grace period after recovery before triggering retry.
 * Gives the network stack a moment to fully stabilize.
 */
const RECOVERY_GRACE_MS = 1500;

export type NetworkState = "online" | "offline" | "unknown";

export class NetworkMonitor implements vscode.Disposable {
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private state: NetworkState = "unknown";
  private lastTransitionTimestamp = 0;
  private consecutiveFailures = 0;
  private readonly recoveryListeners: Array<() => void> = [];
  private readonly stateListeners: Array<(state: NetworkState) => void> = [];

  constructor(private readonly logger: Logger) {}

  /**
   * Subscribe to network recovery events (offline → online transitions).
   */
  onRecovery(listener: () => void): void {
    this.recoveryListeners.push(listener);
  }

  /**
   * Subscribe to all state changes.
   */
  onStateChange(listener: (state: NetworkState) => void): void {
    this.stateListeners.push(listener);
  }

  getState(): NetworkState {
    return this.state;
  }

  /**
   * Start monitoring network connectivity.
   */
  start(): void {
    if (this.pollTimer) {
      return;
    }
    this.logger.info("Network monitor starting");
    // Immediate first check
    void this.probe();
    this.schedulePoll();
  }

  /**
   * Stop monitoring.
   */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  /**
   * Restart with potentially different timing.
   */
  restart(): void {
    this.stop();
    this.start();
  }

  /**
   * Probe network connectivity. Tries each endpoint until one succeeds.
   */
  private async probe(): Promise<void> {
    const reachable = await this.isNetworkReachable();

    if (reachable) {
      this.consecutiveFailures = 0;
      const previousState = this.state;
      this.setState("online");

      if (previousState === "offline") {
        this.lastTransitionTimestamp = Date.now();
        this.logger.info(
          "Network recovered — scheduling retry trigger after grace period",
        );
        // Wait a brief grace period for network to fully stabilize
        setTimeout(() => {
          this.emitRecovery();
        }, RECOVERY_GRACE_MS);
        // Switch back to normal polling interval
        this.schedulePoll();
      }
    } else {
      this.consecutiveFailures++;
      // Require 2 consecutive failures before declaring offline
      // (avoids false positives from single dropped packets)
      if (this.consecutiveFailures >= 2 && this.state !== "offline") {
        this.setState("offline");
        this.lastTransitionTimestamp = Date.now();
        this.logger.warn(
          `Network appears offline (${this.consecutiveFailures} consecutive probe failures)`,
        );
        // Switch to fast polling for quick recovery detection
        this.schedulePoll();
      }
    }
  }

  /**
   * Try to reach any of the probe endpoints.
   */
  private async isNetworkReachable(): Promise<boolean> {
    for (const endpoint of PROBE_ENDPOINTS) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          PROBE_TIMEOUT_MS,
        );

        const response = await fetch(endpoint, {
          method: "HEAD",
          signal: controller.signal,
          // Avoid caches
          headers: { "Cache-Control": "no-cache" },
        });
        clearTimeout(timeoutId);

        // Any HTTP response (even 4xx/5xx) means network is reachable
        // The server is there and responding
        if (response) {
          return true;
        }
      } catch {
        // This endpoint failed, try the next one
        continue;
      }
    }
    return false;
  }

  /**
   * Schedule the periodic poll with appropriate interval.
   */
  private schedulePoll(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    const interval =
      this.state === "offline" ? FAST_POLL_INTERVAL_MS : NORMAL_POLL_INTERVAL_MS;
    this.pollTimer = setInterval(() => {
      void this.probe();
    }, interval);
  }

  private setState(newState: NetworkState): void {
    if (this.state === newState) {
      return;
    }
    const previousState = this.state;
    this.state = newState;
    this.logger.info(`Network state: ${previousState} → ${newState}`);
    for (const listener of this.stateListeners) {
      try {
        listener(newState);
      } catch (error) {
        this.logger.error(
          `Network state listener error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private emitRecovery(): void {
    this.logger.info("Emitting network recovery event");
    for (const listener of this.recoveryListeners) {
      try {
        listener();
      } catch (error) {
        this.logger.error(
          `Recovery listener error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  dispose(): void {
    this.stop();
  }
}

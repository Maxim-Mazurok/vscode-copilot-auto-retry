import * as vscode from "vscode";
import { Logger } from "./logger";
import { readConfig } from "./configuration";
import { ErrorDetector } from "./errorDetector";
import { RetryEngine } from "./retryEngine";

/**
 * Periodic health monitor that polls Copilot's status at configurable intervals.
 *
 * When a health check detects an error state transition (healthy → unhealthy),
 * it feeds the error to the retry engine. When the state recovers (unhealthy → healthy),
 * it cancels any active retry cycle.
 */
/**
 * Grace period (ms) after start() before the first health check runs.
 * Gives Copilot and other extensions time to fully activate so the first
 * poll establishes a correct baseline rather than seeing false negatives.
 */
const STARTUP_GRACE_PERIOD_MS = 10_000;

export class HealthMonitor implements vscode.Disposable {
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private isHealthy = true;
  private lastCheckTimestamp = 0;

  constructor(
    private readonly logger: Logger,
    private readonly errorDetector: ErrorDetector,
    private readonly retryEngine: RetryEngine,
  ) {}

  /**
   * Start the periodic health poll.
   */
  start(): void {
    if (this.pollTimer) {
      return;
    }

    const config = readConfig();
    this.logger.info(
      `Health monitor starting (poll interval: ${config.healthPollIntervalMs}ms, first check in ${STARTUP_GRACE_PERIOD_MS}ms)`,
    );

    // Delay the first check so Copilot has time to fully activate.
    // Without this grace period the first poll sees "extension not active"
    // and "no models" which are normal startup conditions, not errors.
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined;
      void this.performHealthCheck();
      this.pollTimer = setInterval(() => {
        void this.performHealthCheck();
      }, config.healthPollIntervalMs);
    }, STARTUP_GRACE_PERIOD_MS);
  }

  /**
   * Stop the periodic health poll.
   */
  stop(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = undefined;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.logger.info("Health monitor stopped");
  }

  /**
   * Restart with potentially updated configuration.
   */
  restart(): void {
    this.stop();
    this.start();
  }

  /**
   * Execute a single health check cycle.
   */
  private async performHealthCheck(): Promise<void> {
    this.lastCheckTimestamp = Date.now();

    try {
      const errors = await this.errorDetector.checkHealth();

      if (errors.length === 0) {
        // System appears healthy
        if (!this.isHealthy) {
          this.logger.info("Copilot health recovered");
          this.retryEngine.cancelActiveCycle("health recovered");
          this.isHealthy = true;
        }
        return;
      }

      // Filter to only retryable errors
      const retryableErrors = errors.filter(
        (error) => error.classification === "retryable",
      );

      if (retryableErrors.length > 0 && this.isHealthy) {
        this.isHealthy = false;
        this.logger.warn(
          `Copilot health degraded: ${retryableErrors.map((error) => error.kind).join(", ")}`,
        );

        // Trigger retry for the first (most significant) error
        await this.retryEngine.triggerRetryCycle(retryableErrors[0]);
      }
    } catch (checkError) {
      // Health check itself failed — don't cascade
      this.logger.debug(
        `Health check error: ${checkError instanceof Error ? checkError.message : String(checkError)}`,
      );
    }
  }

  /**
   * Get last check timestamp for status display.
   */
  getLastCheckTimestamp(): number {
    return this.lastCheckTimestamp;
  }

  /**
   * Get current perceived health.
   */
  getIsHealthy(): boolean {
    return this.isHealthy;
  }

  dispose(): void {
    this.stop();
  }
}

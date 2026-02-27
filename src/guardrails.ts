import { Logger } from "./logger";
import { readConfig } from "./configuration";

/**
 * Safety guardrails that prevent retry loops, interference with non-Copilot UI,
 * and other pathological behaviors.
 *
 * Every retry attempt must pass through these checks before execution.
 */

/** Tracks a sliding window of recent retry activity. */
interface RetryWindow {
  timestamps: number[];
}

/**
 * Hard ceiling: no more than this many retries in any 60-second window,
 * regardless of configuration. Prevents runaway loops.
 */
const ABSOLUTE_MAX_RETRIES_PER_MINUTE = 15;

/**
 * Minimum interval between any two retry attempts (milliseconds).
 * Even if backoff calculation produces a smaller number, this floor applies.
 */
const MINIMUM_RETRY_INTERVAL_MS = 1000;

/**
 * Cooldown period after the maximum retries for a single error event
 * are exhausted (milliseconds). No new retry cycles start during cooldown.
 */
const CYCLE_COOLDOWN_MS = 60_000;

export class Guardrails {
  private readonly retryWindow: RetryWindow = { timestamps: [] };
  private lastCycleExhaustedAt = 0;
  private consecutiveFailures = 0;

  constructor(private readonly logger: Logger) {}

  /**
   * Returns true if a retry attempt is allowed right now.
   * Checks all safety constraints.
   */
  canRetry(): boolean {
    const now = Date.now();
    const config = readConfig();

    // Guard 1: Extension must be enabled
    if (!config.enabled) {
      this.logger.debug("Guardrail: extension is disabled");
      return false;
    }

    // Guard 2: Cooldown after exhausting a retry cycle
    if (now - this.lastCycleExhaustedAt < CYCLE_COOLDOWN_MS) {
      const remainingSeconds = Math.ceil(
        (CYCLE_COOLDOWN_MS - (now - this.lastCycleExhaustedAt)) / 1000,
      );
      this.logger.debug(
        `Guardrail: in cooldown period (${remainingSeconds}s remaining)`,
      );
      return false;
    }

    // Guard 3: Sliding window rate limit
    this.pruneWindow(now);
    if (this.retryWindow.timestamps.length >= ABSOLUTE_MAX_RETRIES_PER_MINUTE) {
      this.logger.warn(
        "Guardrail: absolute rate limit reached (15 retries/minute)",
      );
      return false;
    }

    // Guard 4: Minimum interval since last retry
    const lastRetryTimestamp =
      this.retryWindow.timestamps[this.retryWindow.timestamps.length - 1];
    if (
      lastRetryTimestamp &&
      now - lastRetryTimestamp < MINIMUM_RETRY_INTERVAL_MS
    ) {
      this.logger.debug("Guardrail: minimum interval not elapsed");
      return false;
    }

    return true;
  }

  /**
   * Record that a retry attempt was made. Must be called after each attempt.
   */
  recordRetryAttempt(): void {
    this.retryWindow.timestamps.push(Date.now());
  }

  /**
   * Record that a retry cycle (all attempts for one error event) was exhausted.
   * Triggers cooldown.
   */
  recordCycleExhausted(): void {
    this.lastCycleExhaustedAt = Date.now();
    this.consecutiveFailures++;
    this.logger.info(
      `Retry cycle exhausted. Cooldown active for ${CYCLE_COOLDOWN_MS / 1000}s. Consecutive failures: ${this.consecutiveFailures}`,
    );
  }

  /**
   * Record that a retry succeeded. Resets consecutive failure counter.
   */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  /**
   * Returns the number of consecutive failed retry cycles.
   * Can be used to escalate warnings.
   */
  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  /**
   * Calculate the delay for a given attempt number using exponential backoff
   * with jitter. Respects guardrail minimums and configured maximums.
   */
  calculateDelay(attemptNumber: number): number {
    const config = readConfig();
    // Exponential: base * 2^(attempt-1)
    const exponentialDelay =
      config.baseDelayMs * Math.pow(2, attemptNumber - 1);
    // Clamp to max
    const clampedDelay = Math.min(exponentialDelay, config.maxDelayMs);
    // Add jitter: ±20%
    const jitterFactor = 0.8 + Math.random() * 0.4;
    const delayWithJitter = Math.round(clampedDelay * jitterFactor);
    // Enforce floor
    return Math.max(delayWithJitter, MINIMUM_RETRY_INTERVAL_MS);
  }

  /**
   * Reset all state. Used when configuration changes or extension is re-enabled.
   */
  reset(): void {
    this.retryWindow.timestamps = [];
    this.lastCycleExhaustedAt = 0;
    this.consecutiveFailures = 0;
  }

  /**
   * Remove timestamps older than 60 seconds from the sliding window.
   */
  private pruneWindow(now: number): void {
    const cutoff = now - 60_000;
    this.retryWindow.timestamps = this.retryWindow.timestamps.filter(
      (timestamp) => timestamp > cutoff,
    );
  }
}

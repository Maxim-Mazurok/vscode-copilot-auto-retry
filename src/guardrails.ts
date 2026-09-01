import { Logger } from "./logger";
import { readConfig } from "./configuration";

/**
 * Light safety layer for continue attempts.
 *
 * By design the extension continues sessions indefinitely — there is no
 * cooldown and no cap that permanently stops continuing. The only hard gate is
 * whether the extension is enabled. A rolling rate limit exists purely to avoid
 * a pathological tight loop (e.g., a session file that rewrites every few ms);
 * it self-clears within the window and never permanently blocks.
 */

/**
 * Absolute ceiling on continue submissions within a rolling minute, purely to
 * avoid a runaway tight loop. Generous enough to never interfere with normal
 * agent turns (which take many seconds each).
 */
const ABSOLUTE_MAX_CONTINUES_PER_MINUTE = 30;

export class Guardrails {
  private continueTimestamps: number[] = [];

  constructor(private readonly logger: Logger) {}

  /**
   * Returns true if a continue attempt is allowed right now. The only reasons
   * to deny are: the extension is disabled, or the rolling loop-protection cap
   * is momentarily hit (which clears itself within the window).
   */
  canContinue(): boolean {
    const now = Date.now();
    const config = readConfig();

    if (!config.enabled) {
      this.logger.debug("Guardrail: extension is disabled");
      return false;
    }

    this.pruneWindow(now);
    if (this.continueTimestamps.length >= ABSOLUTE_MAX_CONTINUES_PER_MINUTE) {
      this.logger.warn(
        `Guardrail: loop protection — ${ABSOLUTE_MAX_CONTINUES_PER_MINUTE} continues in the last minute; ` +
        "pausing briefly (will resume automatically)",
      );
      return false;
    }

    return true;
  }

  /**
   * Record that a continue attempt was made. Must be called after each attempt.
   */
  recordContinueAttempt(): void {
    this.continueTimestamps.push(Date.now());
  }

  /**
   * Delay before the continue attempt for a detected pause. Uses the configured
   * base delay with light jitter — no exponential escalation, since
   * continuation is indefinite and each pause gets one attempt.
   */
  calculateDelay(): number {
    const config = readConfig();
    const jitterFactor = 0.85 + Math.random() * 0.3;
    return Math.round(config.baseDelayMs * jitterFactor);
  }

  /** Reset all state. Used when the extension is (re-)enabled. */
  reset(): void {
    this.continueTimestamps = [];
  }

  /** Remove timestamps older than the rolling window. */
  private pruneWindow(now: number): void {
    const cutoff = now - 60_000;
    this.continueTimestamps = this.continueTimestamps.filter(
      (timestamp) => timestamp > cutoff,
    );
  }
}

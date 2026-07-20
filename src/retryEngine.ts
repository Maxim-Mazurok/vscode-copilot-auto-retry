import * as vscode from "vscode";
import { Logger } from "./logger";
import { readConfig } from "./configuration";
import { Guardrails } from "./guardrails";
import { ActiveSessionResolver } from "./activeSessionResolver";
import { SessionError } from "./sessionWatcher";

/**
 * Manages retry attempts for detected Copilot errors using bounded backoff.
 *
 * ## How retry execution works
 *
 * VS Code's `workbench.action.chat.retry` command exists but requires an
 * internal response-view-model object as its first argument.  When called
 * without arguments it silently returns (no-op).  Third-party extensions
 * cannot access the chat widget's internal view model, so this command is
 * unusable for us.
 *
 * Instead we use the following two-step approach that *does* work:
 *
 *  1. Focus the chat panel (`workbench.panel.chat.view.copilot.focus`)
 *  2. Submit a follow-up message in the *same conversation* via
 *     `workbench.action.chat.submit` with an `inputValue`.
 *
 * This preserves the full conversation context (the AI sees the failed
 * request + error in history) and costs one extra turn, but actually triggers
 * a real LLM call — unlike the no-op command.
 *
 * ## Error detection
 *
 * Errors are detected by the SessionWatcher, which monitors chat session
 * JSONL files on disk for `errorDetails` in request results. This gives us
 * direct visibility into whether a conversation actually has a failed
 * response — no more guessing from service-level health signals.
 */

const RETRY_PROMPT =
  "The previous request failed due to a transient error (network issue or rate limit). " +
  "Please retry the exact same operation you were attempting.";

/** Small pause after focusing the chat panel so the widget initialises. */
const FOCUS_SETTLE_DELAY_MS = 400;

export type RetryEngineState =
  | "idle"
  | "waiting"
  | "retrying"
  | "cooldown"
  | "disabled";

/**
 * Describes the trigger source for a retry cycle.
 * Can come from session file error detection or network recovery.
 */
export interface RetryTrigger {
  /** What caused the retry ("session-error" or "network-recovery"). */
  source: "session-error" | "network-recovery" | "manual";
  /** Copilot error code from the session file (e.g., "networkError"). */
  errorCode?: string;
  /**
   * The session file ID (UUID) where the error was detected.
   * Used to verify the errored session is still the active one before retrying.
   * Only present for "session-error" triggers.
   */
  sessionId?: string;
  /** Human-readable detail about the trigger. */
  detail: string;
  /** When the trigger was created. */
  timestamp: number;
}

interface ActiveRetryCycle {
  trigger: RetryTrigger;
  attemptNumber: number;
  maxAttempts: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  cancelled: boolean;
}

export class RetryEngine implements vscode.Disposable {
  private activeCycle: ActiveRetryCycle | undefined;
  private state: RetryEngineState = "idle";
  private readonly stateChangeListeners: Array<
    (state: RetryEngineState) => void
  > = [];

  constructor(
    private readonly logger: Logger,
    private readonly guardrails: Guardrails,
    private readonly activeSessionResolver?: ActiveSessionResolver,
  ) {}

  /**
   * Subscribe to state changes (for status bar updates).
   */
  onStateChange(listener: (state: RetryEngineState) => void): void {
    this.stateChangeListeners.push(listener);
  }

  /**
   * Get the current engine state.
   */
  getState(): RetryEngineState {
    return this.state;
  }

  /**
   * Get the current attempt number (0 if idle).
   */
  getCurrentAttempt(): number {
    return this.activeCycle?.attemptNumber ?? 0;
  }

  /**
   * Create a RetryTrigger from a SessionError detected by the session watcher.
   */
  static triggerFromSessionError(sessionError: SessionError): RetryTrigger {
    return {
      source: "session-error",
      errorCode: sessionError.errorCode,
      sessionId: sessionError.sessionId,
      detail: `Session ${sessionError.sessionId}: ${sessionError.message.substring(0, 120)}`,
      timestamp: sessionError.detectedAt,
    };
  }

  /**
   * Create a RetryTrigger for a network recovery event.
   */
  static triggerFromNetworkRecovery(): RetryTrigger {
    return {
      source: "network-recovery",
      detail: "Network connectivity recovered after outage",
      timestamp: Date.now(),
    };
  }

  /**
   * Create a manual RetryTrigger (user pressed the retry command).
   */
  static triggerFromManualAction(): RetryTrigger {
    return {
      source: "manual",
      detail: "Manual retry triggered by user",
      timestamp: Date.now(),
    };
  }

  /**
   * Trigger a retry cycle.
   * If a cycle is already active, the new trigger is ignored (debounce).
   */
  async triggerRetryCycle(trigger: RetryTrigger): Promise<void> {
    // Don't start a new cycle if one is active
    if (this.activeCycle && !this.activeCycle.cancelled) {
      this.logger.debug(
        "Retry cycle already active — ignoring duplicate trigger",
      );
      return;
    }

    if (!this.guardrails.canRetry()) {
      this.logger.debug("Guardrails blocked retry cycle start");
      this.setState("cooldown");
      return;
    }

    const config = readConfig();

    this.activeCycle = {
      trigger,
      attemptNumber: 0,
      maxAttempts: config.maxRetries,
      timer: undefined,
      cancelled: false,
    };

    this.logger.info(
      `Starting retry cycle: source=${trigger.source}` +
      (trigger.errorCode ? `, errorCode=${trigger.errorCode}` : "") +
      ` (max ${config.maxRetries} attempts)`,
    );
    await this.scheduleNextAttempt();
  }

  /**
   * Cancel any active retry cycle. Called when the user disables the extension,
   * when the session watcher detects recovery, or when the error resolves.
   */
  cancelActiveCycle(reason: string): void {
    if (!this.activeCycle) {
      return;
    }

    this.activeCycle.cancelled = true;
    if (this.activeCycle.timer) {
      clearTimeout(this.activeCycle.timer);
      this.activeCycle.timer = undefined;
    }

    this.logger.info(`Retry cycle cancelled: ${reason}`);
    this.activeCycle = undefined;
    this.setState("idle");
  }

  /**
   * Schedule the next retry attempt with bounded backoff.
   */
  private async scheduleNextAttempt(): Promise<void> {
    const cycle = this.activeCycle;
    if (!cycle || cycle.cancelled) {
      return;
    }

    cycle.attemptNumber++;

    if (cycle.attemptNumber > cycle.maxAttempts) {
      this.logger.warn(
        `Retry cycle exhausted after ${cycle.maxAttempts} attempts ` +
        `(source: ${cycle.trigger.source})`,
      );
      this.guardrails.recordCycleExhausted();
      this.activeCycle = undefined;
      this.setState("cooldown");
      return;
    }

    const delayMs = this.guardrails.calculateDelay(cycle.attemptNumber);
    this.logger.info(
      `Retry attempt ${cycle.attemptNumber}/${cycle.maxAttempts} scheduled in ${delayMs}ms`,
    );
    this.setState("waiting");

    cycle.timer = setTimeout(async () => {
      if (cycle.cancelled) {
        return;
      }
      await this.executeRetryAttempt(cycle);
    }, delayMs);
  }

  /**
   * Execute a single retry attempt.
   *
   * Strategy:
   * 1. Focus the chat panel so `lastFocusedWidget` is set
   * 2. Submit a follow-up prompt in the same conversation thread
   */
  private async executeRetryAttempt(cycle: ActiveRetryCycle): Promise<void> {
    if (cycle.cancelled) {
      return;
    }

    // Re-check guardrails before every attempt
    if (!this.guardrails.canRetry()) {
      this.logger.warn("Guardrails blocked retry attempt");
      this.cancelActiveCycle("blocked by guardrails");
      return;
    }

    // Verify the errored session is still the active (visible) one.
    // If the user switched to a different session, submitting a retry
    // prompt would go to the wrong conversation.
    if (cycle.trigger.sessionId && this.activeSessionResolver) {
      const sessionIsActive = await this.activeSessionResolver.isSessionActive(
        cycle.trigger.sessionId,
      );
      if (!sessionIsActive) {
        this.cancelActiveCycle(
          `errored session ${cycle.trigger.sessionId} is no longer the active session`,
        );
        return;
      }
    }

    this.setState("retrying");
    this.guardrails.recordRetryAttempt();

    try {
      this.logger.info(
        `Executing retry (attempt ${cycle.attemptNumber}/${cycle.maxAttempts}): focusing chat panel`,
      );

      // Step 1 — Focus the chat panel so the widget is the "lastFocusedWidget"
      await vscode.commands.executeCommand(
        "workbench.panel.chat.view.copilot.focus",
      );

      // Small settle delay so the widget finishes any internal initialisation
      await this.delay(FOCUS_SETTLE_DELAY_MS);

      if (cycle.cancelled) {
        return;
      }

      // Step 2 — Submit a follow-up message in the current conversation.
      // `workbench.action.chat.submit` accepts { inputValue: string } and
      // calls widget.acceptInput(inputValue) on the last focused widget.
      // Preconditions are NOT enforced when called via executeCommand.
      this.logger.info("Submitting retry prompt via chat submit");
      await vscode.commands.executeCommand("workbench.action.chat.submit", {
        inputValue: RETRY_PROMPT,
      });

      this.logger.info("Retry prompt submitted successfully");
      // A completed command only means VS Code accepted the prompt. Keep the
      // cycle running until a session recovery cancels it or it is exhausted.
      await this.scheduleNextAttempt();
    } catch (executeError) {
      const message =
        executeError instanceof Error
          ? executeError.message
          : String(executeError);
      this.logger.warn(`Retry attempt failed: ${message}`);

      // Schedule next attempt if we haven't exhausted the cycle
      await this.scheduleNextAttempt();
    }
  }

  /** Promise-based delay helper. */
  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  private setState(state: RetryEngineState): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    for (const listener of this.stateChangeListeners) {
      try {
        listener(state);
      } catch (listenerError) {
        this.logger.error(
          `State listener error: ${listenerError instanceof Error ? listenerError.message : String(listenerError)}`,
        );
      }
    }
  }

  dispose(): void {
    this.cancelActiveCycle("extension disposing");
  }
}

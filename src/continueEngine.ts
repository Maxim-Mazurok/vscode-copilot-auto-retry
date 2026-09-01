import * as vscode from "vscode";
import { Logger } from "./logger";
import { readConfig } from "./configuration";
import { Guardrails } from "./guardrails";
import { ActiveSessionResolver } from "./activeSessionResolver";
import { SessionPause } from "./sessionWatcher";

/**
 * Sends "continue" messages to keep paused Copilot agent sessions going,
 * indefinitely.
 *
 * Model:
 *  - Each detected pause triggers ONE continue submission (the watcher detects
 *    the next pause after the agent's next turn, so continuation is naturally
 *    open-ended — there is no cooldown and no attempt cap).
 *  - Continues run one at a time. Concurrent pauses are queued (FIFO, deduped
 *    by session id) and drained sequentially. A queued session is never dropped.
 *  - To route a continue to the correct conversation, the target session's
 *    editor is opened/revealed (`vscode.open` on its resource URI) before
 *    submitting; the user's previous focus is restored afterwards.
 */

export type ContinueEngineState = "idle" | "waiting" | "continuing" | "disabled";

/** Describes the trigger source for a continue. */
export interface ContinueTrigger {
  source: "session-pause" | "manual";
  reason?: SessionPause["reason"];
  /** Session file id (UUID); used to focus/verify the right conversation. */
  sessionId?: string;
  detail: string;
  timestamp: number;
}

/** Small pause after focusing so the widget initialises before submitting. */
const FOCUS_SETTLE_DELAY_MS = 400;

/** How long to wait before retrying a continue blocked by loop protection. */
const RATE_LIMIT_RETRY_MS = 3_000;

interface ActiveContinue {
  trigger: ContinueTrigger;
  timer: ReturnType<typeof setTimeout> | undefined;
  cancelled: boolean;
}

export class ContinueEngine implements vscode.Disposable {
  private active: ActiveContinue | undefined;
  private state: ContinueEngineState = "idle";
  private readonly stateChangeListeners: Array<
    (state: ContinueEngineState) => void
  > = [];

  /**
   * Pending session pauses waiting for the active continue to finish. Keyed by
   * session id (deduped); the newest trigger for a session wins.
   */
  private readonly pendingQueue = new Map<string, ContinueTrigger>();

  constructor(
    private readonly logger: Logger,
    private readonly guardrails: Guardrails,
    private readonly activeSessionResolver?: ActiveSessionResolver,
  ) {}

  onStateChange(listener: (state: ContinueEngineState) => void): void {
    this.stateChangeListeners.push(listener);
  }

  getState(): ContinueEngineState {
    return this.state;
  }

  /** Number of sessions waiting in the queue (for status display). */
  getQueueSize(): number {
    return this.pendingQueue.size;
  }

  static triggerFromSessionPause(pause: SessionPause): ContinueTrigger {
    return {
      source: "session-pause",
      reason: pause.reason,
      sessionId: pause.sessionId,
      detail: `Session ${pause.sessionId}: paused (${pause.reason})`,
      timestamp: pause.detectedAt,
    };
  }

  static triggerFromManualAction(): ContinueTrigger {
    return {
      source: "manual",
      detail: "Manual continue triggered by user",
      timestamp: Date.now(),
    };
  }

  /**
   * Request a continue for a paused session. If one is already in progress,
   * the request is queued (deduped by session) and drained later.
   */
  async triggerContinueCycle(trigger: ContinueTrigger): Promise<void> {
    if (this.active && !this.active.cancelled) {
      // Don't re-queue the session currently being continued.
      if (this.active.trigger.sessionId === trigger.sessionId) {
        this.logger.debug(
          "Trigger for the in-progress session — ignoring duplicate",
        );
        return;
      }
      const key = trigger.sessionId ?? trigger.source;
      this.pendingQueue.set(key, trigger);
      this.logger.info(
        `Busy — queued session ${trigger.sessionId ?? trigger.source} (queue size ${this.pendingQueue.size})`,
      );
      return;
    }

    if (!this.guardrails.canContinue()) {
      // Loop protection momentarily hit — don't drop, retry shortly.
      const key = trigger.sessionId ?? trigger.source;
      this.pendingQueue.set(key, trigger);
      this.logger.info(
        `Loop protection active — re-queued session ${key}, retrying in ${RATE_LIMIT_RETRY_MS}ms`,
      );
      setTimeout(() => void this.drainQueue(), RATE_LIMIT_RETRY_MS);
      return;
    }

    this.active = { trigger, timer: undefined, cancelled: false };

    const delayMs = this.guardrails.calculateDelay();
    this.logger.info(
      `Starting continue: source=${trigger.source}` +
      (trigger.sessionId ? `, session=${trigger.sessionId}` : "") +
      (trigger.reason ? `, reason=${trigger.reason}` : "") +
      ` (in ${delayMs}ms)`,
    );
    this.setState("waiting");

    this.active.timer = setTimeout(() => {
      if (this.active && !this.active.cancelled) {
        void this.executeContinue(this.active);
      }
    }, delayMs);
  }

  /**
   * Cancel the in-progress continue. Called when the extension is disabled or
   * the paused session resumes on its own.
   */
  cancelActiveCycle(reason: string): void {
    if (!this.active) {
      return;
    }
    this.active.cancelled = true;
    if (this.active.timer) {
      clearTimeout(this.active.timer);
      this.active.timer = undefined;
    }
    this.logger.info(`Continue cancelled: ${reason}`);
    this.active = undefined;
    this.setState("idle");
    void this.drainQueue();
  }

  /** Drop everything and stop (extension disabled). */
  clearAll(reason: string): void {
    this.pendingQueue.clear();
    this.cancelActiveCycle(reason);
  }

  /**
   * Start the next queued session, if any. Called after each continue finishes
   * so concurrent pauses are handled sequentially without being dropped.
   */
  private async drainQueue(): Promise<void> {
    if (this.active || this.pendingQueue.size === 0) {
      return;
    }
    const [key, nextTrigger] = this.pendingQueue.entries().next().value as [
      string,
      ContinueTrigger,
    ];
    this.pendingQueue.delete(key);
    this.logger.info(
      `Draining queue — continuing session ${nextTrigger.sessionId ?? nextTrigger.source} (remaining ${this.pendingQueue.size})`,
    );
    await this.triggerContinueCycle(nextTrigger);
  }

  /**
   * Execute a single continue:
   *  1. Open/reveal the target session so submit lands in the right conversation
   *  2. Submit the continue message
   *  3. Restore the user's previous focus
   */
  private async executeContinue(active: ActiveContinue): Promise<void> {
    if (active.cancelled) {
      return;
    }

    if (!this.guardrails.canContinue()) {
      // Rate cap hit right before submit — re-queue this session and back off.
      const key = active.trigger.sessionId ?? active.trigger.source;
      this.pendingQueue.set(key, active.trigger);
      this.active = undefined;
      this.setState("idle");
      this.logger.info(
        `Loop protection active at submit time — re-queued session ${key}, retrying in ${RATE_LIMIT_RETRY_MS}ms`,
      );
      setTimeout(() => void this.drainQueue(), RATE_LIMIT_RETRY_MS);
      return;
    }

    this.setState("continuing");
    this.guardrails.recordContinueAttempt();

    // Remember the tab the user was on so we can restore it after submitting.
    const previouslyActiveEditor = vscode.window.activeTextEditor?.document.uri;
    const previouslyActiveTabInput =
      vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    this.logger.debug(
      `Pre-continue focus snapshot: activeEditor=${previouslyActiveEditor?.toString() ?? "none"}, ` +
      `activeTab=${describeTabInput(previouslyActiveTabInput)}`,
    );

    try {
      // Step 1 — focus the specific session's editor.
      this.logger.debug(
        `Step 1/3: focusing target session ${active.trigger.sessionId ?? "(none — panel fallback)"}`,
      );
      const focusedTarget = await this.focusSession(active.trigger.sessionId);
      this.logger.info(`Continuing: focused ${focusedTarget}`);

      this.logger.debug(`Settling ${FOCUS_SETTLE_DELAY_MS}ms before submit`);
      await this.delay(FOCUS_SETTLE_DELAY_MS);
      if (active.cancelled) {
        return;
      }

      // Step 2 — verify the intended session is now the active one, if we can.
      if (active.trigger.sessionId && this.activeSessionResolver) {
        const activeSessionId =
          await this.activeSessionResolver.getActiveSessionId();
        this.logger.debug(
          `Step 2/3: active session reported as ${activeSessionId ?? "(unknown — cannot verify)"}`,
        );
        if (
          activeSessionId !== undefined &&
          activeSessionId !== active.trigger.sessionId
        ) {
          // Positively the wrong session is active — skip to avoid mis-sending.
          this.logger.warn(
            `Active session (${activeSessionId}) != target (${active.trigger.sessionId}) — skipping to avoid wrong conversation`,
          );
          this.active = undefined;
          this.setState("idle");
          await this.restoreFocus(
            previouslyActiveEditor,
            previouslyActiveTabInput,
          );
          void this.drainQueue();
          return;
        }
      }

      // Step 3 — submit the continue message.
      const continueMessage = readConfig().continueMessage;
      this.logger.info(
        `Step 3/3: submitting continue ("${continueMessage.substring(0, 60)}") to session ${active.trigger.sessionId ?? "(focused)"}`,
      );
      await vscode.commands.executeCommand("workbench.action.chat.submit", {
        inputValue: continueMessage,
      });
      this.logger.info(
        `Continue submitted to session ${active.trigger.sessionId ?? "(focused)"}`,
      );

      this.active = undefined;
      this.setState("idle");

      this.logger.debug("Restoring previous focus");
      await this.restoreFocus(previouslyActiveEditor, previouslyActiveTabInput);

      void this.drainQueue();
    } catch (executeError) {
      const message =
        executeError instanceof Error
          ? executeError.message
          : String(executeError);
      this.logger.warn(`Continue failed: ${message}`);
      this.active = undefined;
      this.setState("idle");
      void this.drainQueue();
    }
  }

  /**
   * Bring the target session to the foreground so a submit lands there.
   * A local session is addressable as `vscode-chat-session://local/<b64url(id)>`.
   * Falls back to focusing the chat panel when there's no id or open fails.
   */
  private async focusSession(sessionId: string | undefined): Promise<string> {
    if (sessionId) {
      const uri = buildLocalChatSessionUri(sessionId);
      this.logger.debug(`Opening session editor: ${uri.toString()}`);
      try {
        await vscode.commands.executeCommand("vscode.open", uri, {
          preview: false,
        });
        return `session ${sessionId} (${uri.toString()})`;
      } catch (openError) {
        this.logger.warn(
          `vscode.open for session ${sessionId} failed (${openError instanceof Error ? openError.message : String(openError)}) — falling back to panel focus`,
        );
      }
    }

    this.logger.debug("Focusing chat panel (fallback)");
    await vscode.commands.executeCommand(
      "workbench.panel.chat.view.copilot.focus",
    );
    return "chat panel (fallback)";
  }

  /**
   * Restore the editor/tab the user was on before we focused the session.
   * Best-effort — failures are ignored.
   */
  private async restoreFocus(
    previousEditorUri: vscode.Uri | undefined,
    previousTabInput: unknown,
  ): Promise<void> {
    try {
      if (previousEditorUri) {
        this.logger.debug(`Restoring text editor: ${previousEditorUri.toString()}`);
        await vscode.window.showTextDocument(previousEditorUri, {
          preserveFocus: false,
        });
        return;
      }
      if (
        previousTabInput instanceof vscode.TabInputText ||
        previousTabInput instanceof vscode.TabInputCustom
      ) {
        this.logger.debug(
          `Restoring previous tab: ${previousTabInput.uri.toString()}`,
        );
        await vscode.commands.executeCommand(
          "vscode.open",
          previousTabInput.uri,
        );
      } else {
        this.logger.debug(
          "No restorable previous focus (no text editor or known tab) — leaving focus as-is",
        );
      }
    } catch (restoreError) {
      this.logger.debug(
        `Could not restore previous focus: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
      );
    }
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  private setState(state: ContinueEngineState): void {
    if (this.state === state) {
      return;
    }
    this.logger.debug(`Engine state: ${this.state} → ${state}`);
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
    this.clearAll("extension disposing");
  }
}

/**
 * Build the editor resource URI for a local chat session:
 *   `vscode-chat-session://local/<base64url(sessionId)>`
 * where the session id is the JSONL filename (a UUID), base64url-encoded with
 * no padding, and the authority is the local session type ("local").
 */
export function buildLocalChatSessionUri(sessionId: string): vscode.Uri {
  const encoded = Buffer.from(sessionId, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return vscode.Uri.from({
    scheme: "vscode-chat-session",
    authority: "local",
    path: `/${encoded}`,
  });
}

/** Short human-readable description of an active tab input, for logging. */
function describeTabInput(tabInput: unknown): string {
  if (
    tabInput instanceof vscode.TabInputText ||
    tabInput instanceof vscode.TabInputCustom
  ) {
    return tabInput.uri.toString();
  }
  if (tabInput === undefined || tabInput === null) {
    return "none";
  }
  return (tabInput as object).constructor?.name ?? "unknown";
}

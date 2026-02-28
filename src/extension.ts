import * as vscode from "vscode";
import { Logger } from "./logger";
import { readConfig, setEnabled } from "./configuration";
import { RetryEngine } from "./retryEngine";
import { Guardrails } from "./guardrails";
import { ActiveSessionResolver } from "./activeSessionResolver";
import { NetworkMonitor } from "./networkMonitor";
import { SessionWatcher } from "./sessionWatcher";
import { StatusBar } from "./statusBar";

/**
 * Extension entry point.
 *
 * Architecture:
 *
 *   SessionWatcher ──▶ RetryEngine ──▶ chat.submit (focus + send prompt)
 *   (filesystem)          │
 *        ▲                ▼
 *        │            Guardrails
 *   NetworkMonitor        │
 *        │                │
 *        └────────────────┘
 *             StatusBar (read-only view)
 *
 * The SessionWatcher monitors Copilot's chat session JSONL files on disk to
 * detect when a conversation has a failed response with a retryable error
 * (e.g., network error, rate limit). This is the PRIMARY error detection
 * mechanism — it gives direct visibility into conversation error state,
 * unlike the previous approach of inferring errors from service health.
 *
 * The NetworkMonitor provides a secondary signal: when connectivity drops
 * and recovers, it triggers a retry in case a chat request failed during
 * the outage and the session file hasn't been updated yet.
 *
 * The extension activates lazily (onStartupFinished) and begins watching
 * session files immediately. When a retryable error is detected, the retry
 * engine fires with bounded exponential backoff.
 */
export function activate(context: vscode.ExtensionContext): void {
  const logger = new Logger();
  logger.info("Copilot Auto-Retry activating...");

  const guardrails = new Guardrails(logger);
  const activeSessionResolver = new ActiveSessionResolver(logger);
  activeSessionResolver.initialize(context.storageUri);
  const retryEngine = new RetryEngine(logger, guardrails, activeSessionResolver);
  const networkMonitor = new NetworkMonitor(logger);
  const sessionWatcher = new SessionWatcher(logger);
  const statusBar = new StatusBar(logger);

  // ── Primary error detection: session file watcher ──────────────────────
  //
  // The SessionWatcher monitors `chatSessions/*.jsonl` files in VS Code's
  // workspace storage. When a chat request result contains `errorDetails`
  // with a retryable error code (e.g., "networkError") and a "Try Again"
  // confirmation button, the watcher emits a retryable error event.
  //
  // This is the most reliable signal available: it reads the same data that
  // populates the "Try Again" button in the chat UI.

  sessionWatcher.onRetryableError((sessionError) => {
    const config = readConfig();
    if (!config.enabled) {
      return;
    }

    logger.info(
      `Session watcher detected retryable error: code=${sessionError.errorCode} ` +
      `in session ${sessionError.sessionId}`,
    );

    const trigger = RetryEngine.triggerFromSessionError(sessionError);
    void retryEngine.triggerRetryCycle(trigger);
  });

  // When the session watcher detects that a previously-errored session now
  // has a successful result, cancel any active retry cycle for it.
  sessionWatcher.onRecovery((sessionId) => {
    logger.info(
      `Session ${sessionId} recovered — cancelling retry if active`,
    );
    retryEngine.cancelActiveCycle(`session ${sessionId} recovered`);
  });

  // ── Secondary signal: network recovery ─────────────────────────────────
  //
  // Chat panel errors like "net::ERR_NETWORK_CHANGED" are invisible to the
  // extension API. The session file usually gets updated with errorDetails,
  // but network recovery is still a useful secondary trigger in case the
  // session file write is delayed.

  networkMonitor.onRecovery(() => {
    const config = readConfig();
    if (!config.enabled) {
      return;
    }

    // Only trigger a retry if the session watcher has detected an
    // unresolved error in THIS window's chat sessions.  Without this
    // gate, every open VS Code window would fire a retry when the
    // network recovers — even windows where no chat request failed.
    if (!sessionWatcher.hasActiveErrors()) {
      logger.info(
        "Network recovered but no active session errors in this window — skipping retry",
      );
      return;
    }

    logger.info(
      "Network recovered after outage — triggering retry for active session error",
    );

    const trigger = RetryEngine.triggerFromNetworkRecovery();
    void retryEngine.triggerRetryCycle(trigger);
  });

  // Wire network state into logging
  networkMonitor.onStateChange((state) => {
    if (state === "offline") {
      logger.warn("Network offline detected — watching for recovery");
    }
  });

  // Wire retry engine state changes → status bar
  retryEngine.onStateChange((state) => {
    const config = readConfig();
    statusBar.updateDisplay(
      state,
      retryEngine.getCurrentAttempt(),
      config.maxRetries,
    );
  });

  // ── Commands ───────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("copilotAutoRetry.enable", async () => {
      await setEnabled(true);
      guardrails.reset();
      networkMonitor.restart();
      await sessionWatcher.start(context.storageUri);
      statusBar.updateDisplay("idle");
      logger.info("Extension enabled by user");
      vscode.window.showInformationMessage("Copilot Auto-Retry enabled.");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("copilotAutoRetry.disable", async () => {
      await setEnabled(false);
      retryEngine.cancelActiveCycle("disabled by user");
      networkMonitor.stop();
      sessionWatcher.stop();
      statusBar.updateDisplay("disabled");
      logger.info("Extension disabled by user");
      vscode.window.showInformationMessage("Copilot Auto-Retry disabled.");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "copilotAutoRetry.toggleEnabled",
      async () => {
        const config = readConfig();
        if (config.enabled) {
          await vscode.commands.executeCommand("copilotAutoRetry.disable");
        } else {
          await vscode.commands.executeCommand("copilotAutoRetry.enable");
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("copilotAutoRetry.showStatus", async () => {
      const config = readConfig();
      const engineState = retryEngine.getState();
      const consecutiveFailures = guardrails.getConsecutiveFailures();

      const lines: string[] = [
        `Enabled: ${config.enabled}`,
        `Engine state: ${engineState}`,
        `Network: ${networkMonitor.getState()}`,
        `Max retries: ${config.maxRetries}`,
        `Base delay: ${config.baseDelayMs}ms`,
        `Consecutive failures: ${consecutiveFailures}`,
        `Detection: session file watcher + network monitor`,
        `Retry method: chat submit (focus + follow-up prompt)`,
      ];

      logger.show();
      logger.info(`Status report:\n  ${lines.join("\n  ")}`);
      vscode.window.showInformationMessage(
        `Copilot Auto-Retry: ${engineState} | Network: ${networkMonitor.getState()} | Failed cycles: ${consecutiveFailures}`,
      );
    }),
  );

  // Manual retry trigger — for when the user sees an error but auto-detection
  // hasn't fired (e.g., session file write is delayed or the error type is
  // not in our retryable list).
  context.subscriptions.push(
    vscode.commands.registerCommand("copilotAutoRetry.retryNow", async () => {
      const config = readConfig();
      if (!config.enabled) {
        vscode.window.showWarningMessage(
          "Copilot Auto-Retry is disabled. Enable it first.",
        );
        return;
      }

      logger.info("Manual retry triggered by user");

      // If a cycle is already running, inform the user
      if (retryEngine.getState() !== "idle") {
        vscode.window.showInformationMessage(
          `Copilot Auto-Retry: already ${retryEngine.getState()} ` +
          `(attempt ${retryEngine.getCurrentAttempt()}/${config.maxRetries})`,
        );
        return;
      }

      const trigger = RetryEngine.triggerFromManualAction();
      await retryEngine.triggerRetryCycle(trigger);
    }),
  );

  // Dev command: simulate a session error to test the full retry pipeline.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "copilotAutoRetry.simulateError",
      async () => {
        const config = readConfig();
        if (!config.enabled) {
          vscode.window.showWarningMessage(
            "Copilot Auto-Retry is disabled. Enable it first.",
          );
          return;
        }

        logger.show();
        logger.info("=== SIMULATION START ===");
        logger.info(
          "Injecting synthetic session error into the retry pipeline...",
        );
        logger.info(
          "Retry method: focus chat panel → submit follow-up prompt",
        );

        const trigger: ReturnType<typeof RetryEngine.triggerFromSessionError> = {
          source: "session-error",
          errorCode: "networkError",
          detail: "[SIMULATED] Network error in chat session",
          timestamp: Date.now(),
        };

        vscode.window.showInformationMessage(
          "Copilot Auto-Retry: simulating error. Watch the output channel and status bar.",
        );

        await retryEngine.triggerRetryCycle(trigger);
        logger.info(
          "Retry cycle triggered. Watch the status bar and output channel for progress.",
        );
      },
    ),
  );

  // React to configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("copilotAutoRetry")) {
        return;
      }

      logger.info("Configuration changed — applying");
      const config = readConfig();

      if (!config.enabled) {
        retryEngine.cancelActiveCycle("disabled via settings");
        networkMonitor.stop();
        sessionWatcher.stop();
        statusBar.updateDisplay("disabled");
      } else {
        networkMonitor.restart();
        void sessionWatcher.start(context.storageUri);
        statusBar.updateDisplay(retryEngine.getState());
      }
    }),
  );

  // Register disposables
  context.subscriptions.push(retryEngine);
  context.subscriptions.push(networkMonitor);
  context.subscriptions.push(sessionWatcher);
  context.subscriptions.push(statusBar);
  context.subscriptions.push({ dispose: () => logger.dispose() });

  // Initial startup
  const config = readConfig();

  if (config.enabled) {
    networkMonitor.start();
    void sessionWatcher.start(context.storageUri);
    statusBar.updateDisplay("idle");
  } else {
    statusBar.updateDisplay("disabled");
  }

  logger.info("Copilot Auto-Retry activated (detection: session file watcher)");
}

export function deactivate(): void {
  // All cleanup is handled via context.subscriptions disposables
}

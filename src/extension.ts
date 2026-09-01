import * as vscode from "vscode";
import { Logger } from "./logger";
import { readConfig, setEnabled } from "./configuration";
import { ContinueEngine } from "./continueEngine";
import { Guardrails } from "./guardrails";
import { ActiveSessionResolver } from "./activeSessionResolver";
import { SessionWatcher } from "./sessionWatcher";
import { StatusBar } from "./statusBar";

/**
 * Extension entry point.
 *
 * Architecture:
 *
 *   SessionWatcher ──▶ ContinueEngine ──▶ chat.submit (focus + send prompt)
 *   (filesystem)          │
 *                         ▼
 *                     Guardrails
 *                         │
 *                     StatusBar (read-only view)
 *
 * The SessionWatcher monitors Copilot's chat session JSONL files on disk to
 * detect when an agent session has PAUSED — the agent's turn ended, or it is
 * presenting a continue button — and could be nudged forward. When a pause is
 * detected, the ContinueEngine sends a directive continue message (with
 * bounded exponential backoff) so a long-running agent task keeps going while
 * you're away.
 *
 * The extension activates lazily (onStartupFinished) and begins watching
 * session files immediately.
 */
export function activate(context: vscode.ExtensionContext): void {
  const logger = new Logger();
  logger.setVerbose(readConfig().verboseLogging);
  logger.info("Copilot Long Run activating...");

  const guardrails = new Guardrails(logger);
  const activeSessionResolver = new ActiveSessionResolver(logger);
  activeSessionResolver.initialize(
    context.storageUri,
    context.globalStorageUri,
  );
  const continueEngine = new ContinueEngine(
    logger,
    guardrails,
    activeSessionResolver,
  );
  const sessionWatcher = new SessionWatcher(logger);
  const statusBar = new StatusBar(logger);

  // ── Pause detection: session file watcher ──────────────────────────────
  //
  // The SessionWatcher monitors `chatSessions/*.jsonl` files in VS Code's
  // workspace storage. When the latest request completes (turn ended) or
  // presents a continue button, the watcher emits a pause event.

  sessionWatcher.onPauseDetected((pause) => {
    const config = readConfig();
    if (!config.enabled) {
      return;
    }

    logger.info(
      `Session watcher detected pause: reason=${pause.reason} ` +
      `in session ${pause.sessionId}`,
    );

    const trigger = ContinueEngine.triggerFromSessionPause(pause);
    void continueEngine.triggerContinueCycle(trigger);
  });

  // When the watcher detects that a previously-paused session resumed on its
  // own (a newer request is in flight), cancel any active continue cycle.
  sessionWatcher.onResume((sessionId) => {
    logger.info(
      `Session ${sessionId} resumed — cancelling continue if active`,
    );
    continueEngine.cancelActiveCycle(`session ${sessionId} resumed`);
  });

  // Wire continue engine state changes → status bar
  continueEngine.onStateChange((state) => {
    statusBar.updateDisplay(state, continueEngine.getQueueSize());
  });

  // ── Commands ───────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("copilotLongRun.enable", async () => {
      await setEnabled(true);
      guardrails.reset();
      await sessionWatcher.start(context.storageUri, context.globalStorageUri);
      statusBar.updateDisplay("idle");
      logger.info("Extension enabled by user");
      vscode.window.showInformationMessage("Copilot Long Run enabled.");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("copilotLongRun.disable", async () => {
      await setEnabled(false);
      continueEngine.clearAll("disabled by user");
      sessionWatcher.stop();
      statusBar.updateDisplay("disabled");
      logger.info("Extension disabled by user");
      vscode.window.showInformationMessage("Copilot Long Run disabled.");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "copilotLongRun.toggleEnabled",
      async () => {
        const config = readConfig();
        if (config.enabled) {
          await vscode.commands.executeCommand("copilotLongRun.disable");
        } else {
          await vscode.commands.executeCommand("copilotLongRun.enable");
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("copilotLongRun.showStatus", async () => {
      const config = readConfig();
      const engineState = continueEngine.getState();
      const queueSize = continueEngine.getQueueSize();

      const lines: string[] = [
        `Enabled: ${config.enabled}`,
        `Engine state: ${engineState}`,
        `Queued sessions: ${queueSize}`,
        `Base delay: ${config.baseDelayMs}ms`,
        `Continue message: ${config.continueMessage}`,
        `Detection: session file watcher (pause detection)`,
        `Continue method: focus session editor + chat submit`,
      ];

      logger.show();
      logger.info(`Status report:\n  ${lines.join("\n  ")}`);
      vscode.window.showInformationMessage(
        `Copilot Long Run: ${engineState} | Queued: ${queueSize}`,
      );
    }),
  );

  // Manual continue trigger — for when the user wants to nudge the agent
  // forward without waiting for auto-detection.
  context.subscriptions.push(
    vscode.commands.registerCommand("copilotLongRun.continueNow", async () => {
      const config = readConfig();
      if (!config.enabled) {
        vscode.window.showWarningMessage(
          "Copilot Long Run is disabled. Enable it first.",
        );
        return;
      }

      logger.info("Manual continue triggered by user");

      const trigger = ContinueEngine.triggerFromManualAction();
      await continueEngine.triggerContinueCycle(trigger);
    }),
  );

  // Dev command: simulate a session pause to test the full continue pipeline.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "copilotLongRun.simulatePause",
      async () => {
        const config = readConfig();
        if (!config.enabled) {
          vscode.window.showWarningMessage(
            "Copilot Long Run is disabled. Enable it first.",
          );
          return;
        }

        logger.show();
        logger.info("=== SIMULATION START ===");
        logger.info(
          "Injecting synthetic session pause into the continue pipeline...",
        );
        logger.info(
          "Continue method: focus chat panel → submit follow-up prompt",
        );

        const trigger: ReturnType<
          typeof ContinueEngine.triggerFromSessionPause
        > = {
          source: "session-pause",
          reason: "turn-ended",
          detail: "[SIMULATED] Agent turn ended in chat session",
          timestamp: Date.now(),
        };

        vscode.window.showInformationMessage(
          "Copilot Long Run: simulating pause. Watch the output channel and status bar.",
        );

        await continueEngine.triggerContinueCycle(trigger);
        logger.info(
          "Continue cycle triggered. Watch the status bar and output channel for progress.",
        );
      },
    ),
  );

  // React to configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("copilotLongRun")) {
        return;
      }

      logger.info("Configuration changed — applying");
      const config = readConfig();
      logger.setVerbose(config.verboseLogging);

      if (!config.enabled) {
        continueEngine.clearAll("disabled via settings");
        sessionWatcher.stop();
        statusBar.updateDisplay("disabled");
      } else {
        void sessionWatcher.start(context.storageUri, context.globalStorageUri);
        statusBar.updateDisplay(continueEngine.getState());
      }
    }),
  );

  // Register disposables
  context.subscriptions.push(continueEngine);
  context.subscriptions.push(sessionWatcher);
  context.subscriptions.push(statusBar);
  context.subscriptions.push({ dispose: () => logger.dispose() });

  // Initial startup
  const config = readConfig();

  if (config.enabled) {
    void sessionWatcher.start(context.storageUri, context.globalStorageUri);
    statusBar.updateDisplay("idle");
  } else {
    statusBar.updateDisplay("disabled");
  }

  logger.info("Copilot Long Run activated (detection: session file watcher)");
}

export function deactivate(): void {
  // All cleanup is handled via context.subscriptions disposables
}

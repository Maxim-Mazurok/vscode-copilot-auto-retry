import * as vscode from "vscode";
import { Logger } from "./logger";
import { readConfig, setEnabled } from "./configuration";
import { ErrorDetector, DetectedError } from "./errorDetector";
import { RetryEngine } from "./retryEngine";
import { Guardrails } from "./guardrails";
import { HealthMonitor } from "./healthMonitor";
import { NetworkMonitor } from "./networkMonitor";
import { StatusBar } from "./statusBar";

/**
 * Extension entry point.
 *
 * Architecture:
 *
 *   ErrorDetector ──▶ RetryEngine ──▶ chat.submit (focus + send prompt)
 *        ▲                │
 *        │                ▼
 *   HealthMonitor     Guardrails
 *        │                │
 *        └────────────────┘
 *             StatusBar (read-only view)
 *
 * The extension activates lazily (onStartupFinished), discovers available
 * retry commands, and begins periodic health monitoring. When a transient
 * error is detected, the retry engine fires with bounded exponential backoff.
 */
export function activate(context: vscode.ExtensionContext): void {
  const logger = new Logger();
  logger.info("Copilot Auto-Retry activating...");

  const guardrails = new Guardrails(logger);
  const errorDetector = new ErrorDetector(logger);
  const retryEngine = new RetryEngine(logger, guardrails);
  const healthMonitor = new HealthMonitor(logger, errorDetector, retryEngine);
  const networkMonitor = new NetworkMonitor(logger);
  const statusBar = new StatusBar(logger);

  // Wire network recovery → auto-retry, but ONLY if the health monitor has
  // already detected a degraded state. A blind retry on every network
  // reconnect would submit a chat prompt into an empty/healthy conversation.
  networkMonitor.onRecovery(() => {
    const config = readConfig();
    if (!config.enabled) {
      return;
    }

    if (healthMonitor.getIsHealthy()) {
      logger.info(
        "Network recovered but Copilot health is OK — skipping retry (no known conversation error)",
      );
      return;
    }

    logger.info(
      "Network recovered while Copilot health was degraded — triggering retry",
    );

    const syntheticError: DetectedError = {
      kind: "offline",
      classification: "retryable",
      timestamp: Date.now(),
      detail: "Network connectivity recovered — retrying failed chat requests",
    };

    void retryEngine.triggerRetryCycle(syntheticError);
  });

  // Wire network state into status bar
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

  // Wire error detector events → retry engine
  errorDetector.onError((error) => {
    if (error.classification === "retryable") {
      void retryEngine.triggerRetryCycle(error);
    }
  });

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("copilotAutoRetry.enable", async () => {
      await setEnabled(true);
      guardrails.reset();
      healthMonitor.restart();
      networkMonitor.restart();
      statusBar.updateDisplay("idle");
      logger.info("Extension enabled by user");
      vscode.window.showInformationMessage("Copilot Auto-Retry enabled.");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("copilotAutoRetry.disable", async () => {
      await setEnabled(false);
      retryEngine.cancelActiveCycle("disabled by user");
      healthMonitor.stop();
      networkMonitor.stop();
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
      const copilotInstalled = errorDetector.isCopilotExtensionInstalled();
      const copilotActive = errorDetector.isCopilotExtensionActive();
      const healthy = healthMonitor.getIsHealthy();
      const consecutiveFailures = guardrails.getConsecutiveFailures();

      const lines: string[] = [
        `Enabled: ${config.enabled}`,
        `Engine state: ${engineState}`,
        `Network: ${networkMonitor.getState()}`,
        `Copilot installed: ${copilotInstalled}`,
        `Copilot active: ${copilotActive}`,
        `Health: ${healthy ? "OK" : "DEGRADED"}`,
        `Max retries: ${config.maxRetries}`,
        `Base delay: ${config.baseDelayMs}ms`,
        `Consecutive failures: ${consecutiveFailures}`,
        `Retry method: chat submit (focus + follow-up prompt)`,
      ];

      logger.show();
      logger.info(`Status report:\n  ${lines.join("\n  ")}`);
      vscode.window.showInformationMessage(
        `Copilot Auto-Retry: ${engineState} | Health: ${healthy ? "OK" : "Degraded"} | Retries: ${consecutiveFailures} cycles failed`,
      );
    }),
  );

  // Manual retry trigger — for when the user sees an error but auto-detection
  // hasn't fired (e.g., in-chat rate limit with "Try Again" button visible).
  // Starts a retry cycle immediately using the primary chat retry command.
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
          `Copilot Auto-Retry: already ${retryEngine.getState()} (attempt ${retryEngine.getCurrentAttempt()}/${config.maxRetries})`,
        );
        return;
      }

      // Create a synthetic "rate-limited" error to drive the retry cycle
      const syntheticError: DetectedError = {
        kind: "rate-limited",
        classification: "retryable",
        timestamp: Date.now(),
        detail: "Manual retry triggered by user",
      };

      await retryEngine.triggerRetryCycle(syntheticError);
    }),
  );

  // Dev command: simulate a rate-limit error to test the full retry pipeline.
  // Injects a synthetic error, triggers the retry engine, and logs every step
  // to the output channel so you can verify the flow end-to-end.
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

        logger.show(); // Open the output channel so the user sees the logs
        logger.info("=== SIMULATION START ===");
        logger.info(
          "Injecting synthetic rate-limit error into the retry pipeline...",
        );
        logger.info(
          "Retry method: focus chat panel → submit follow-up prompt",
        );

        const syntheticError: DetectedError = {
          kind: "rate-limited",
          classification: "retryable",
          timestamp: Date.now(),
          detail:
            "[SIMULATED] Sorry, you have exhausted this model's rate limit. Please wait before trying again.",
        };

        vscode.window.showInformationMessage(
          "Copilot Auto-Retry: simulating rate-limit error. Watch the output channel and status bar.",
        );

        await retryEngine.triggerRetryCycle(syntheticError);
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
        healthMonitor.stop();
        networkMonitor.stop();
        statusBar.updateDisplay("disabled");
      } else {
        healthMonitor.restart();
        networkMonitor.restart();
        statusBar.updateDisplay(retryEngine.getState());
      }
    }),
  );

  // Register disposables
  context.subscriptions.push(errorDetector);
  context.subscriptions.push(retryEngine);
  context.subscriptions.push(healthMonitor);
  context.subscriptions.push(networkMonitor);
  context.subscriptions.push(statusBar);
  context.subscriptions.push({ dispose: () => logger.dispose() });

  // Initial startup
  const config = readConfig();

  if (!errorDetector.isCopilotExtensionInstalled()) {
    logger.warn(
      "GitHub Copilot extension not found — Copilot Auto-Retry will remain dormant until Copilot is installed",
    );
    statusBar.updateDisplay("idle");
    // Still start monitoring in case Copilot gets installed later
  }

  if (config.enabled) {
    healthMonitor.start();
    networkMonitor.start();
    statusBar.updateDisplay("idle");
  } else {
    statusBar.updateDisplay("disabled");
  }

  logger.info("Copilot Auto-Retry activated");
}

export function deactivate(): void {
  // All cleanup is handled via context.subscriptions disposables
}

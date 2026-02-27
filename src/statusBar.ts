import * as vscode from "vscode";
import { Logger } from "./logger";
import { readConfig } from "./configuration";
import { RetryEngineState } from "./retryEngine";

/**
 * Status bar item that shows the extension's current state.
 *
 * States:
 *   $(check)  — Idle, monitoring normally
 *   $(sync~spin) — Retry in progress
 *   $(clock)  — Waiting for backoff timer
 *   $(warning) — In cooldown after exhausting retries
 *   $(x)  — Disabled
 */
export class StatusBar implements vscode.Disposable {
  private readonly statusBarItem: vscode.StatusBarItem;

  constructor(private readonly logger: Logger) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      50,
    );
    this.statusBarItem.command = "copilotAutoRetry.toggleEnabled";
    this.updateDisplay("idle");
    this.statusBarItem.show();
  }

  /**
   * Update the status bar to reflect the current engine state.
   */
  updateDisplay(
    engineState: RetryEngineState,
    currentAttempt?: number,
    maxAttempts?: number,
  ): void {
    const config = readConfig();

    if (!config.enabled) {
      this.statusBarItem.text = "$(x) Copilot Retry: Off";
      this.statusBarItem.tooltip = "Copilot Auto-Retry is disabled. Click to enable.";
      this.statusBarItem.backgroundColor = undefined;
      return;
    }

    switch (engineState) {
      case "idle":
        this.statusBarItem.text = "$(check) Copilot Retry";
        this.statusBarItem.tooltip = "Copilot Auto-Retry: monitoring. Click to toggle.";
        this.statusBarItem.backgroundColor = undefined;
        break;

      case "waiting":
        this.statusBarItem.text = `$(clock) Retry ${currentAttempt ?? "?"}/${maxAttempts ?? "?"}`;
        this.statusBarItem.tooltip =
          "Copilot Auto-Retry: waiting for backoff timer before next attempt.";
        this.statusBarItem.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.warningBackground",
        );
        break;

      case "retrying":
        this.statusBarItem.text = `$(sync~spin) Retrying ${currentAttempt ?? "?"}/${maxAttempts ?? "?"}`;
        this.statusBarItem.tooltip =
          "Copilot Auto-Retry: executing retry command now.";
        this.statusBarItem.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.warningBackground",
        );
        break;

      case "cooldown":
        this.statusBarItem.text = "$(warning) Retry Cooldown";
        this.statusBarItem.tooltip =
          "Copilot Auto-Retry: retries exhausted, in cooldown period. Will resume monitoring soon.";
        this.statusBarItem.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.errorBackground",
        );
        break;

      case "disabled":
        this.statusBarItem.text = "$(x) Copilot Retry: Off";
        this.statusBarItem.tooltip = "Copilot Auto-Retry is disabled. Click to enable.";
        this.statusBarItem.backgroundColor = undefined;
        break;
    }
  }

  dispose(): void {
    this.statusBarItem.dispose();
  }
}

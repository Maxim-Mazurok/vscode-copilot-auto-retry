import * as vscode from "vscode";
import { Logger } from "./logger";
import { readConfig } from "./configuration";
import { ContinueEngineState } from "./continueEngine";

/**
 * Status bar item that shows the extension's current state.
 *
 * States:
 *   $(check)  — Idle, monitoring normally
 *   $(sync~spin) — Continue in progress
 *   $(clock)  — Waiting for backoff timer
 *   $(x)  — Disabled
 */
export class StatusBar implements vscode.Disposable {
  private readonly statusBarItem: vscode.StatusBarItem;

  constructor(private readonly logger: Logger) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      50,
    );
    this.statusBarItem.command = "copilotLongRun.toggleEnabled";
    this.updateDisplay("idle");
    this.statusBarItem.show();
  }

  /**
   * Update the status bar to reflect the current engine state.
   */
  updateDisplay(engineState: ContinueEngineState, queueSize = 0): void {
    const config = readConfig();

    if (!config.enabled) {
      this.statusBarItem.text = "$(x) Long Run: Off";
      this.statusBarItem.tooltip = "Copilot Long Run is disabled. Click to enable.";
      this.statusBarItem.backgroundColor = undefined;
      return;
    }

    const queueSuffix = queueSize > 0 ? ` (+${queueSize})` : "";

    switch (engineState) {
      case "idle":
        this.statusBarItem.text = "$(check) Long Run";
        this.statusBarItem.tooltip = "Copilot Long Run: monitoring. Click to toggle.";
        this.statusBarItem.backgroundColor = undefined;
        break;

      case "waiting":
        this.statusBarItem.text = `$(clock) Continue${queueSuffix}`;
        this.statusBarItem.tooltip =
          "Copilot Long Run: waiting briefly before sending continue.";
        this.statusBarItem.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.warningBackground",
        );
        break;

      case "continuing":
        this.statusBarItem.text = `$(sync~spin) Continuing${queueSuffix}`;
        this.statusBarItem.tooltip =
          "Copilot Long Run: sending continue message now.";
        this.statusBarItem.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.warningBackground",
        );
        break;

      case "disabled":
        this.statusBarItem.text = "$(x) Long Run: Off";
        this.statusBarItem.tooltip = "Copilot Long Run is disabled. Click to enable.";
        this.statusBarItem.backgroundColor = undefined;
        break;
    }
  }

  dispose(): void {
    this.statusBarItem.dispose();
  }
}

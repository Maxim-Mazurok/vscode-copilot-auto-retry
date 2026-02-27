import * as vscode from "vscode";

/**
 * Structured logger that writes to a dedicated output channel.
 * All extension activity is logged here for transparency and debugging.
 */
export class Logger {
  private readonly outputChannel: vscode.LogOutputChannel;

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel(
      "Copilot Auto-Retry",
      { log: true },
    );
  }

  info(message: string): void {
    this.outputChannel.info(message);
  }

  warn(message: string): void {
    this.outputChannel.warn(message);
  }

  error(message: string): void {
    this.outputChannel.error(message);
  }

  debug(message: string): void {
    this.outputChannel.debug(message);
  }

  show(): void {
    this.outputChannel.show(true);
  }

  dispose(): void {
    this.outputChannel.dispose();
  }
}

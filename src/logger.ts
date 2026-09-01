import * as vscode from "vscode";

/**
 * Structured logger that writes to a dedicated output channel.
 * All extension activity is logged here for transparency and debugging.
 */
export class Logger {
  private readonly outputChannel: vscode.LogOutputChannel;

  /**
   * When true, `debug()` messages are also written at `info` level so they
   * appear without changing the output channel's log-level dropdown.
   */
  private verbose = false;

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel(
      "Copilot Long Run",
      { log: true },
    );
  }

  setVerbose(verbose: boolean): void {
    this.verbose = verbose;
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
    if (this.verbose) {
      this.outputChannel.info(`[debug] ${message}`);
    } else {
      this.outputChannel.debug(message);
    }
  }

  show(): void {
    this.outputChannel.show(true);
  }

  dispose(): void {
    this.outputChannel.dispose();
  }
}

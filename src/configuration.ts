import * as vscode from "vscode";

/**
 * Resolved configuration values for the extension.
 * Re-read on each access to respect live changes.
 */
export interface ResolvedConfig {
  enabled: boolean;
  continueMessage: string;
  maxContinues: number;
  baseDelayMs: number;
  maxDelayMs: number;
  verboseLogging: boolean;
}

const SECTION = "copilotLongRun";

const DEFAULT_CONTINUE_MESSAGE = "Keep going until the task is fully complete.";

export function readConfig(): ResolvedConfig {
  const configuration = vscode.workspace.getConfiguration(SECTION);
  return {
    enabled: configuration.get<boolean>("enabled", true),
    continueMessage: configuration.get<string>(
      "continueMessage",
      DEFAULT_CONTINUE_MESSAGE,
    ),
    maxContinues: configuration.get<number>("maxContinues", 3),
    baseDelayMs: configuration.get<number>("baseDelayMs", 2000),
    maxDelayMs: configuration.get<number>("maxDelayMs", 30000),
    verboseLogging: configuration.get<boolean>("verboseLogging", false),
  };
}

export async function setEnabled(value: boolean): Promise<void> {
  const configuration = vscode.workspace.getConfiguration(SECTION);
  await configuration.update(
    "enabled",
    value,
    vscode.ConfigurationTarget.Global,
  );
}

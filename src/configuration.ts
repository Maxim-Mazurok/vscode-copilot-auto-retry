import * as vscode from "vscode";

/**
 * Resolved configuration values for the extension.
 * Re-read on each access to respect live changes.
 */
export interface ResolvedConfig {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const SECTION = "copilotAutoRetry";

export function readConfig(): ResolvedConfig {
  const configuration = vscode.workspace.getConfiguration(SECTION);
  return {
    enabled: configuration.get<boolean>("enabled", true),
    maxRetries: configuration.get<number>("maxRetries", 3),
    baseDelayMs: configuration.get<number>("baseDelayMs", 2000),
    maxDelayMs: configuration.get<number>("maxDelayMs", 30000),
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

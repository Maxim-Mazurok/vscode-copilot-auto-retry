import * as vscode from "vscode";
import { Logger } from "./logger";

/**
 * Classifies Copilot error states into retryable vs. non-retryable categories.
 *
 * Detection relies on multiple lightweight signals:
 * 1. Copilot extension activation state
 * 2. Language Model availability (vscode.lm API)
 * 3. Language Model accessibility probe (catches rate-limit errors)
 * 4. vscode.lm.onDidChangeChatModels reactive event
 * 5. Diagnostic changes sourced from Copilot
 *
 * This module NEVER reads prompt content, wraps Copilot commands, or
 * intercepts Copilot's request pipeline. The LM probe sends a minimal
 * single-token request and cancels it immediately — it only checks whether
 * the model accepts requests, not what it generates.
 */

/** Describes the type of detected error. */
export type ErrorKind =
  | "rate-limited"
  | "offline"
  | "model-unavailable"
  | "transient-diagnostic"
  | "extension-inactive"
  | "unknown-transient";

/** Whether a detected error is safe to retry. */
export type RetryClassification = "retryable" | "non-retryable" | "ambiguous";

export interface DetectedError {
  kind: ErrorKind;
  classification: RetryClassification;
  timestamp: number;
  detail: string;
}

/** Extension IDs for Copilot. */
const COPILOT_EXTENSION_IDS = [
  "GitHub.copilot",
  "GitHub.copilot-chat",
  "github.copilot",
  "github.copilot-chat",
];

/**
 * Known Copilot diagnostic source names (case-insensitive matching).
 */
const COPILOT_DIAGNOSTIC_SOURCES = ["copilot", "github.copilot"];

/**
 * Patterns in error/diagnostic messages that indicate transient failures.
 * These patterns are matched against both diagnostic messages and LM error messages.
 */
const TRANSIENT_ERROR_PATTERNS: RegExp[] = [
  /rate.?limit/i,
  /exhausted.*(?:rate|limit|quota|model)/i,
  /too many requests/i,
  /network.?error/i,
  /timeout/i,
  /timed?\s*out/i,
  /connection.?(refused|reset|closed)/i,
  /ECONNREFUSED/,
  /ENOTFOUND/,
  /ETIMEDOUT/,
  /service.?unavailable/i,
  /temporarily.?unavailable/i,
  /503/,
  /502/,
  /429/,
  /server.?error/i,
  /internal.?server/i,
  /try.?again/i,
  /please.?wait/i,
  /premium.?model.?quota/i,
  /monthly.?free.*exhausted/i,
];

/**
 * Patterns that indicate NON-retryable problems (user action required).
 */
const NON_RETRYABLE_PATTERNS: RegExp[] = [
  /auth(entication|orization)?\s*(fail|error|invalid)/i,
  /invalid.?token/i,
  /expired.?(token|subscription|session)/i,
  /access.?denied/i,
  /forbidden/i,
  /not.?authorized/i,
  /subscription.?(expired|inactive)/i,
  /sign.?in/i,
  /login.?required/i,
  /upgrade.?to.?copilot/i,
  /enable.+paid.+premium/i,
];

export class ErrorDetector implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly errorListeners: Array<(error: DetectedError) => void> = [];

  /**
   * Tracks whether the last health check found models available.
   * Starts as `undefined` (no check performed yet) so the first poll
   * establishes a baseline without triggering a false degradation event.
   */
  private lastModelAvailable: boolean | undefined = undefined;
  /**
   * Tracks whether the last LM probe succeeded (no rate-limit).
   * Starts as `undefined` — see `lastModelAvailable` for rationale.
   */
  private lastProbeSucceeded: boolean | undefined = undefined;
  /**
   * Tracks whether the Copilot extension was last seen as active.
   * Starts as `undefined` — see `lastModelAvailable` for rationale.
   */
  private lastExtensionActive: boolean | undefined = undefined;

  constructor(private readonly logger: Logger) {
    // Subscribe to diagnostic changes
    this.disposables.push(
      vscode.languages.onDidChangeDiagnostics((event) => {
        this.handleDiagnosticChange(event);
      }),
    );

    // Subscribe to language model changes (reactive signal)
    if (vscode.lm?.onDidChangeChatModels) {
      this.disposables.push(
        vscode.lm.onDidChangeChatModels(() => {
          this.handleModelListChange();
        }),
      );
    }
  }

  /**
   * Register a callback for when an error is detected.
   */
  onError(listener: (error: DetectedError) => void): void {
    this.errorListeners.push(listener);
  }

  /**
   * Perform a health check. Called periodically by the health monitor.
   * Returns detected errors (if any).
   */
  async checkHealth(): Promise<DetectedError[]> {
    const errors: DetectedError[] = [];

    // Check 1: Is the Copilot extension active?
    const extensionActive = this.isCopilotExtensionActive();
    if (!extensionActive && this.lastExtensionActive) {
      const error: DetectedError = {
        kind: "extension-inactive",
        classification: "retryable",
        timestamp: Date.now(),
        detail: "Copilot extension became inactive",
      };
      errors.push(error);
      this.logger.warn(error.detail);
    }
    this.lastExtensionActive = extensionActive;

    // Check 2: Are language models available?
    const modelAvailable = await this.areModelsAvailable();
    if (!modelAvailable && this.lastModelAvailable) {
      const error: DetectedError = {
        kind: "model-unavailable",
        classification: "retryable",
        timestamp: Date.now(),
        detail: "Copilot language models became unavailable",
      };
      errors.push(error);
      this.logger.warn(error.detail);
    }
    this.lastModelAvailable = modelAvailable;

    // Check 3: Probe model accessibility (catches rate limits)
    // Only run the probe if models are available (models present but refusing requests = rate limit)
    if (modelAvailable) {
      const probeResult = await this.probeModelAccessibility();
      if (!probeResult.accessible && this.lastProbeSucceeded) {
        const errorKind = probeResult.rateLimited
          ? "rate-limited"
          : "unknown-transient";
        const classification = probeResult.rateLimited
          ? "retryable"
          : "ambiguous";
        const error: DetectedError = {
          kind: errorKind,
          classification,
          timestamp: Date.now(),
          detail: `LM probe: ${probeResult.detail}`,
        };
        if (classification === "retryable") {
          errors.push(error);
          this.logger.warn(error.detail);
        } else {
          this.logger.debug(`Ambiguous probe result: ${probeResult.detail}`);
        }
      }
      this.lastProbeSucceeded = probeResult.accessible;
    }

    // Emit all detected errors
    for (const error of errors) {
      this.emitError(error);
    }

    return errors;
  }

  /**
   * Check if the Copilot extension is installed and active.
   */
  isCopilotExtensionActive(): boolean {
    for (const extensionId of COPILOT_EXTENSION_IDS) {
      const extension = vscode.extensions.getExtension(extensionId);
      if (extension?.isActive) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if the Copilot extension is installed (regardless of active state).
   */
  isCopilotExtensionInstalled(): boolean {
    for (const extensionId of COPILOT_EXTENSION_IDS) {
      const extension = vscode.extensions.getExtension(extensionId);
      if (extension) {
        return true;
      }
    }
    return false;
  }

  /**
   * Attempt to query for available Copilot language models.
   * An empty result set strongly signals an error state.
   */
  private async areModelsAvailable(): Promise<boolean> {
    try {
      if (!vscode.lm?.selectChatModels) {
        return true;
      }
      const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
      // Also check for any vendor's models (user may be using Grok, Claude, etc.)
      if (models.length > 0) {
        return true;
      }
      const allModels = await vscode.lm.selectChatModels({});
      return allModels.length > 0;
    } catch {
      this.logger.debug(
        "Language model query failed — models may be unavailable",
      );
      return false;
    }
  }

  /**
   * Probe whether Copilot models are actually accepting requests.
   * Makes a minimal sendRequest call and cancels immediately.
   * If the model is rate-limited, the error is thrown before any tokens are
   * generated, so this costs zero quota in the rate-limited case.
   */
  private async probeModelAccessibility(): Promise<{
    accessible: boolean;
    rateLimited: boolean;
    detail: string;
  }> {
    try {
      if (!vscode.lm?.selectChatModels) {
        return { accessible: true, rateLimited: false, detail: "API not available" };
      }

      // Probe ANY available model, not just copilot vendor.
      // The user may be using Grok, Claude, etc.
      let models = await vscode.lm.selectChatModels({ vendor: "copilot" });
      if (models.length === 0) {
        models = await vscode.lm.selectChatModels({});
      }
      if (models.length === 0) {
        return {
          accessible: false,
          rateLimited: false,
          detail: "No models available",
        };
      }

      // Pick the first available model and make a minimal probe request
      const model = models[0];
      const cancellationSource = new vscode.CancellationTokenSource();
      const probeMessage = vscode.LanguageModelChatMessage.User("ping");

      try {
        const response = model.sendRequest(
          [probeMessage],
          { justification: "Copilot Auto-Retry health probe" },
          cancellationSource.token,
        );

        // Cancel immediately — we only want to know if the request is accepted
        cancellationSource.cancel();

        // Await to catch any errors from the request setup phase
        // The response is a thenable; we consume then discard
        try {
          const stream = await response;
          // If we got here, the model accepted our request — it's accessible
          // Consume the stream to avoid dangling promises
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for await (const _fragment of stream.stream) {
            break; // We don't need any content
          }
        } catch {
          // Cancellation error is expected — that means the model was accessible
          // (it accepted the request before we cancelled)
        }

        return { accessible: true, rateLimited: false, detail: "Model accepting requests" };
      } catch (probeError) {
        // Error during request setup (before cancellation) = actual model error
        if (
          probeError instanceof vscode.LanguageModelError ||
          (probeError instanceof Error && "code" in probeError)
        ) {
          const errorMessage =
            probeError instanceof Error ? probeError.message : String(probeError);
          const classification = this.classifyErrorMessage(errorMessage);

          if (classification === "non-retryable") {
            // Auth/subscription issues — don't treat as rate limit
            return {
              accessible: false,
              rateLimited: false,
              detail: `Non-retryable: ${errorMessage.slice(0, 100)}`,
            };
          }

          const isRateLimit =
            classification === "retryable" ||
            /rate.?limit|exhausted|quota|429|too many/i.test(errorMessage);

          return {
            accessible: false,
            rateLimited: isRateLimit,
            detail: errorMessage.slice(0, 150),
          };
        }

        // Unknown error — don't assume rate limit
        return {
          accessible: false,
          rateLimited: false,
          detail: `Unknown probe error: ${probeError instanceof Error ? probeError.message : String(probeError)}`.slice(
            0,
            150,
          ),
        };
      } finally {
        cancellationSource.dispose();
      }
    } catch (outerError) {
      // Entire probe infrastructure failed — fail open (assume accessible)
      this.logger.debug(
        `Probe infrastructure error: ${outerError instanceof Error ? outerError.message : String(outerError)}`,
      );
      return { accessible: true, rateLimited: false, detail: "Probe failed, assuming OK" };
    }
  }

  /**
   * Handle reactive model list changes from vscode.lm.onDidChangeChatModels.
   * This fires when models are added or removed.
   */
  private handleModelListChange(): void {
    this.logger.info("Language model list changed — scheduling health check");
    // Don't act directly; just invalidate our cached state so the next
    // health check picks up the change immediately. If models disappeared,
    // checkHealth() will detect it.
    this.lastModelAvailable = true; // Reset so the next check detects a transition
    this.lastProbeSucceeded = true;
  }

  /**
   * Handle diagnostic changes and look for Copilot-sourced transient errors.
   */
  private handleDiagnosticChange(event: vscode.DiagnosticChangeEvent): void {
    for (const uri of event.uris) {
      const diagnostics = vscode.languages.getDiagnostics(uri);
      for (const diagnostic of diagnostics) {
        if (!this.isCopilotDiagnostic(diagnostic)) {
          continue;
        }

        const classification = this.classifyErrorMessage(diagnostic.message);
        if (classification === "non-retryable") {
          continue;
        }

        if (classification === "retryable") {
          const error: DetectedError = {
            kind: "transient-diagnostic",
            classification: "retryable",
            timestamp: Date.now(),
            detail: `Copilot diagnostic: ${diagnostic.message.slice(0, 120)}`,
          };
          this.logger.warn(error.detail);
          this.emitError(error);
        }
        // "ambiguous" is silently ignored per design requirements
      }
    }
  }

  /**
   * Determines if a diagnostic was produced by Copilot.
   */
  private isCopilotDiagnostic(diagnostic: vscode.Diagnostic): boolean {
    const source = (diagnostic.source ?? "").toLowerCase();
    return COPILOT_DIAGNOSTIC_SOURCES.some(
      (copilotSource) =>
        source === copilotSource || source.startsWith(`${copilotSource}.`),
    );
  }

  /**
   * Classify an error/diagnostic message as retryable, non-retryable, or ambiguous.
   */
  classifyErrorMessage(message: string): RetryClassification {
    // Check non-retryable patterns first (they take priority)
    for (const pattern of NON_RETRYABLE_PATTERNS) {
      if (pattern.test(message)) {
        return "non-retryable";
      }
    }

    // Check transient/retryable patterns
    for (const pattern of TRANSIENT_ERROR_PATTERNS) {
      if (pattern.test(message)) {
        return "retryable";
      }
    }

    // Unknown message: treat as ambiguous (fail-silent)
    return "ambiguous";
  }

  /**
   * Classify an error kind as retryable or not.
   */
  static classifyErrorKind(kind: ErrorKind): RetryClassification {
    switch (kind) {
      case "rate-limited":
      case "offline":
      case "model-unavailable":
      case "transient-diagnostic":
      case "extension-inactive":
        return "retryable";
      case "unknown-transient":
        return "ambiguous";
    }
  }

  private emitError(error: DetectedError): void {
    for (const listener of this.errorListeners) {
      try {
        listener(error);
      } catch (listenerError) {
        this.logger.error(
          `Error listener threw: ${listenerError instanceof Error ? listenerError.message : String(listenerError)}`,
        );
      }
    }
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

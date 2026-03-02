import * as vscode from "vscode";
import { Logger } from "./logger";

/**
 * Watches Copilot chat session files on disk to detect conversation errors.
 *
 * VS Code persists chat sessions as JSONL files in:
 *   `workspaceStorage/<hash>/chatSessions/*.jsonl`
 *
 * Each line in a JSONL file is one of:
 *   - `kind: 0` — Full state snapshot (initial session state)
 *   - `kind: 1` — Key-path patch (e.g., set `requests[N].result` to a value)
 *   - `kind: 2` — Key replacement (e.g., replace entire `requests` array)
 *
 * When a chat request fails, VS Code writes a `kind: 1` line with:
 *   `k: ["requests", N, "result"]`
 *   `v: { errorDetails: { code, message, confirmationButtons, ... } }`
 *
 * If `errorDetails.confirmationButtons` contains `copilotContinueOnError: true`,
 * the error is retryable (this is the same signal the built-in "Try Again"
 * button uses).
 *
 * This module watches those files and emits an event when a retryable error
 * is detected in the most recent request of any session.
 */

/** Describes an error found in a chat session file. */
export interface SessionError {
  /** The session file that contains the error. */
  sessionId: string;
  /** The error code from Copilot (e.g., "networkError", "canceled"). */
  errorCode: string;
  /** Human-readable error message. */
  message: string;
  /** Whether Copilot considers this retryable (has "Try Again" button). */
  hasRetryButton: boolean;
  /** Timestamp when we detected this error. */
  detectedAt: number;
}

/**
 * Error codes that we should NOT auto-retry because they're user-initiated.
 * "canceled" typically means the user pressed the Stop button.
 */
export const NON_RETRYABLE_ERROR_CODES = new Set(["canceled"]);

/**
 * Debounce interval for filesystem watcher events (milliseconds).
 * VS Code may fire multiple change events for a single write operation.
 */
const WATCHER_DEBOUNCE_MS = 500;

/**
 * How many bytes to read from the tail of large session files.
 *
 * Session JSONL files are append-only. After the last result entry, VS Code
 * typically writes only a few small entries (followups, modelState, response
 * replacement — totalling ~5 KB). The result entry itself can be large (up
 * to ~200 KB observed) when it carries tool-call metadata.
 *
 * 512 KB comfortably covers all observed real-world sessions. If the result
 * happens to be outside this window (e.g., an exceptionally large result
 * entry), the scanner falls back to reading the full file.
 */
const TAIL_READ_BYTES = 524_288;

export class SessionWatcher implements vscode.Disposable {
  private fileWatcher: vscode.FileSystemWatcher | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly errorListeners: Array<(error: SessionError) => void> = [];
  private readonly recoveryListeners: Array<(sessionId: string) => void> = [];
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Tracks the last error we detected per session to avoid duplicate triggers.
   * Key: session file name, Value: serialized error signature.
   */
  private lastDetectedErrors = new Map<string, string>();

  private chatSessionsDirectory: vscode.Uri | undefined;

  constructor(private readonly logger: Logger) {}

  /**
   * Subscribe to retryable error detection events.
   */
  onRetryableError(listener: (error: SessionError) => void): void {
    this.errorListeners.push(listener);
  }

  /**
   * Subscribe to recovery events (a session that previously had an error
   * now has a successful result for its last request).
   */
  onRecovery(listener: (sessionId: string) => void): void {
    this.recoveryListeners.push(listener);
  }

  /**
   * Returns true if at least one session in this workspace currently has an
   * unresolved retryable error. Used to gate secondary retry triggers
   * (e.g., network recovery) so they don't fire in windows where the chat
   * is working fine.
   */
  hasActiveErrors(): boolean {
    return this.lastDetectedErrors.size > 0;
  }

  /**
   * Start watching chat session files.
   * Requires the extension context to locate the workspace storage directory.
   */
  async start(extensionStorageUri: vscode.Uri | undefined): Promise<void> {
    if (!extensionStorageUri) {
      this.logger.warn(
        "No workspace storage URI available — session watcher cannot start",
      );
      return;
    }

    // Navigate from extension storage (workspaceStorage/<hash>/<ext-id>/)
    // up to workspace storage root (workspaceStorage/<hash>/)
    // then into chatSessions/
    const workspaceStorageRoot = vscode.Uri.joinPath(extensionStorageUri, "..");
    this.chatSessionsDirectory = vscode.Uri.joinPath(
      workspaceStorageRoot,
      "chatSessions",
    );

    // Verify the directory exists
    try {
      const stat = await vscode.workspace.fs.stat(this.chatSessionsDirectory);
      if (stat.type !== vscode.FileType.Directory) {
        this.logger.warn(
          "chatSessions path exists but is not a directory — session watcher inactive",
        );
        return;
      }
    } catch {
      this.logger.info(
        "chatSessions directory not found yet — will watch for its creation",
      );
      // The directory may not exist yet if no chat sessions have been created.
      // We'll still set up the watcher — VS Code's FileSystemWatcher handles
      // watching for directory creation.
    }

    this.logger.info(
      `Session watcher starting — monitoring: ${this.chatSessionsDirectory.fsPath}`,
    );

    // Watch for JSONL file changes in the chatSessions directory
    const pattern = new vscode.RelativePattern(
      this.chatSessionsDirectory,
      "*.jsonl",
    );
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

    this.disposables.push(
      this.fileWatcher.onDidChange((uri) => {
        this.handleFileChange(uri);
      }),
    );

    this.disposables.push(
      this.fileWatcher.onDidCreate((uri) => {
        this.handleFileChange(uri);
      }),
    );

    this.disposables.push(this.fileWatcher);

    // Perform an initial scan of existing session files to detect
    // errors that occurred before this extension activated.
    await this.performInitialScan();
  }

  /**
   * Stop watching session files.
   */
  stop(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.fileWatcher = undefined;

    this.logger.info("Session watcher stopped");
  }

  /**
   * Handle a file change event (debounced).
   */
  private handleFileChange(uri: vscode.Uri): void {
    const fileName = uri.path.split("/").pop() ?? "";

    // Debounce: VS Code may fire multiple events for a single write
    const existingTimer = this.debounceTimers.get(fileName);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    this.debounceTimers.set(
      fileName,
      setTimeout(() => {
        this.debounceTimers.delete(fileName);
        void this.scanSessionFile(uri);
      }, WATCHER_DEBOUNCE_MS),
    );
  }

  /**
   * Scan all existing session files on startup.
   * Only checks the most recently modified file (the likely active session).
   */
  private async performInitialScan(): Promise<void> {
    if (!this.chatSessionsDirectory) {
      return;
    }

    try {
      const entries = await vscode.workspace.fs.readDirectory(
        this.chatSessionsDirectory,
      );
      const jsonlFiles = entries
        .filter(
          ([name, type]) =>
            name.endsWith(".jsonl") && type === vscode.FileType.File,
        )
        .map(([name]) => name);

      if (jsonlFiles.length === 0) {
        this.logger.debug("No session files found during initial scan");
        return;
      }

      // Find the most recently modified file
      let mostRecentFile: string | undefined;
      let mostRecentModified = 0;

      for (const fileName of jsonlFiles) {
        const fileUri = vscode.Uri.joinPath(
          this.chatSessionsDirectory,
          fileName,
        );
        try {
          const fileStat = await vscode.workspace.fs.stat(fileUri);
          if (fileStat.mtime > mostRecentModified) {
            mostRecentModified = fileStat.mtime;
            mostRecentFile = fileName;
          }
        } catch {
          // File may have been deleted between readDirectory and stat
        }
      }

      if (mostRecentFile) {
        this.logger.debug(
          `Initial scan: checking most recent session file: ${mostRecentFile}`,
        );
        const fileUri = vscode.Uri.joinPath(
          this.chatSessionsDirectory,
          mostRecentFile,
        );
        await this.scanSessionFile(fileUri);
      }
    } catch (scanError) {
      this.logger.debug(
        `Initial scan failed: ${scanError instanceof Error ? scanError.message : String(scanError)}`,
      );
    }
  }

  /**
   * Scan a session JSONL file for error state in the most recent request.
   *
   * Strategy: read the last 512 KB of the file and parse complete JSONL
   * lines to find the most recent result entry. 512 KB comfortably covers all
   * observed real-world sessions. If the result entry is not in the tail
   * (e.g., an exceptionally large result followed by small trailing entries),
   * falls back to reading the full file.
   */
  private async scanSessionFile(fileUri: vscode.Uri): Promise<void> {
    const sessionId =
      fileUri.path.split("/").pop()?.replace(".jsonl", "") ?? "";

    try {
      const fileStat = await vscode.workspace.fs.stat(fileUri);
      const fileSize = fileStat.size;

      const content = await this.readSessionContent(
        fileUri,
        fileSize,
        sessionId,
      );
      this.processSessionContent(sessionId, content);
    } catch (readError) {
      // File may be in the process of being written — ignore transient errors
      this.logger.debug(
        `Failed to read session file ${sessionId}: ${readError instanceof Error ? readError.message : String(readError)}`,
      );
    }
  }

  /**
   * Read enough of a session file to find the latest result entry.
   *
   * Small files (≤ 512 KB) are read in full. Larger files get a 512 KB tail
   * read first; if that doesn't contain a result entry, the full file is read
   * as a fallback.
   */
  private async readSessionContent(
    fileUri: vscode.Uri,
    fileSize: number,
    sessionId: string,
  ): Promise<string> {
    if (fileSize <= TAIL_READ_BYTES) {
      const rawBytes = await vscode.workspace.fs.readFile(fileUri);
      return Buffer.from(rawBytes).toString("utf-8");
    }

    // Large file — try the tail first
    const nodeFilesystem = await import("fs/promises");
    const tailContent = await this.readFileTail(
      nodeFilesystem,
      fileUri.fsPath,
      fileSize,
    );

    const parsed = parseSessionContent(tailContent);
    if (parsed.highestResultRequestIndex >= 0) {
      return tailContent;
    }

    // No result in tail — fall back to reading the full file
    this.logger.debug(
      `No result entries in last ${TAIL_READ_BYTES} bytes of session ${sessionId} — reading full file`,
    );
    return nodeFilesystem.readFile(fileUri.fsPath, "utf-8");
  }

  /**
   * Read the last TAIL_READ_BYTES of a file.
   * Skips the first (likely truncated) line.
   */
  private async readFileTail(
    nodeFilesystem: typeof import("fs/promises"),
    filePath: string,
    fileSize: number,
  ): Promise<string> {
    const fileHandle = await nodeFilesystem.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(TAIL_READ_BYTES);
      const readOffset = fileSize - TAIL_READ_BYTES;
      await fileHandle.read(buffer, 0, TAIL_READ_BYTES, readOffset);
      let content = buffer.toString("utf-8");
      // The first "line" is likely truncated — skip it
      const firstNewline = content.indexOf("\n");
      if (firstNewline >= 0) {
        content = content.substring(firstNewline + 1);
      }
      return content;
    } finally {
      await fileHandle.close();
    }
  }

  /**
   * Parse JSONL content and determine the error state of the most recent request.
   */
  private processSessionContent(sessionId: string, content: string): void {
    const parsedResult = parseSessionContent(content);

    const latestErrorDetails = parsedResult?.latestError;

    // Determine what to emit based on the latest state
    const previousError = this.lastDetectedErrors.get(sessionId);
    const currentErrorSignature = latestErrorDetails
      ? `${latestErrorDetails.requestIndex}:${latestErrorDetails.code}:${latestErrorDetails.message.substring(0, 50)}`
      : undefined;

    if (latestErrorDetails && latestErrorDetails.hasRetryButton) {
      if (!NON_RETRYABLE_ERROR_CODES.has(latestErrorDetails.code)) {
        // New retryable error detected
        if (currentErrorSignature !== previousError) {
          this.lastDetectedErrors.set(sessionId, currentErrorSignature!);

          const sessionError: SessionError = {
            sessionId,
            errorCode: latestErrorDetails.code,
            message: latestErrorDetails.message,
            hasRetryButton: true,
            detectedAt: Date.now(),
          };

          this.logger.info(
            `Retryable error detected in session ${sessionId}: ` +
            `code=${latestErrorDetails.code}, ` +
            `request #${latestErrorDetails.requestIndex}`,
          );

          this.emitRetryableError(sessionError);
        } else {
          this.logger.debug(
            `Same error still present in session ${sessionId} — not re-triggering`,
          );
        }
      } else {
        this.logger.debug(
          `Non-retryable error in session ${sessionId}: code=${latestErrorDetails.code} (skipped)`,
        );
      }
    } else if (previousError && !currentErrorSignature) {
      // The session previously had an error but now the latest request succeeded
      this.lastDetectedErrors.delete(sessionId);
      this.logger.info(
        `Session ${sessionId} recovered — last request completed successfully`,
      );
      this.emitRecovery(sessionId);
    }
  }

  private emitRetryableError(error: SessionError): void {
    for (const listener of this.errorListeners) {
      try {
        listener(error);
      } catch (listenerError) {
        this.logger.error(
          `Session error listener threw: ${listenerError instanceof Error ? listenerError.message : String(listenerError)}`,
        );
      }
    }
  }

  private emitRecovery(sessionId: string): void {
    for (const listener of this.recoveryListeners) {
      try {
        listener(sessionId);
      } catch (listenerError) {
        this.logger.error(
          `Session recovery listener threw: ${listenerError instanceof Error ? listenerError.message : String(listenerError)}`,
        );
      }
    }
  }

  dispose(): void {
    this.stop();
  }
}

/* ═══════════════════════════ Exported types ═══════════════════════════════ */

/** Loose type for a parsed JSONL line. */
export interface JsonlEntry {
  kind: number;
  k?: (string | number)[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  v?: any;
}

/**
 * Structure of the `errorDetails` object inside a chat result.
 *
 * This matches the shape VS Code core writes to `chatSessions/*.jsonl`
 * when a chat request fails. Two known variants have been observed in
 * production session files:
 *
 * ### Network error (`code: "networkError"`)
 *
 * Occurs when the network connection drops during a chat request
 * (e.g., ERR_NETWORK_CHANGED). Shape:
 *
 * ```json
 * {
 *   "code": "networkError",
 *   "message": "Sorry, there was a network error. Please try again later. ...",
 *   "confirmationButtons": [
 *     { "data": { "copilotContinueOnError": true }, "label": "Try Again" }
 *   ],
 *   "responseIsIncomplete": true
 * }
 * ```
 *
 * ### Rate limit (`code: "rateLimited"`)
 *
 * Occurs when the user has exceeded a model's rate limit. Shape:
 *
 * ```json
 * {
 *   "code": "rateLimited",
 *   "message": "Sorry, you have exhausted this model's rate limit. ...",
 *   "level": 0,
 *   "isRateLimited": true,
 *   "confirmationButtons": [
 *     { "data": { "copilotContinueOnError": true }, "label": "Try Again" }
 *   ],
 *   "responseIsIncomplete": true
 * }
 * ```
 *
 * ### User cancellation (`code: "canceled"`)
 *
 * Occurs when the user presses the Stop button. Also has a "Try Again"
 * button but should NOT be auto-retried. Shape:
 *
 * ```json
 * {
 *   "code": "canceled",
 *   "message": "Canceled",
 *   "confirmationButtons": [
 *     { "data": { "copilotContinueOnError": true }, "label": "Try Again" }
 *   ],
 *   "responseIsIncomplete": true
 * }
 * ```
 */
export interface ErrorDetails {
  code?: string;
  message?: string;
  /** Present on rate-limit errors. */
  level?: number;
  /** Present on rate-limit errors — `true` when the error is a rate limit. */
  isRateLimited?: boolean;
  confirmationButtons?: ConfirmationButton[];
  responseIsIncomplete?: boolean;
}

/** A confirmation button attached to an error result. */
export interface ConfirmationButton {
  label?: string;
  data?: {
    copilotContinueOnError?: boolean;
  };
}

/* ═════════════════════ Exported pure parsing functions ═════════════════════ */

/**
 * Result of parsing a session file's JSONL content.
 * Contains the latest error details (if any) for the most recent request.
 */
export interface ParsedSessionResult {
  latestError: {
    code: string;
    message: string;
    hasRetryButton: boolean;
    requestIndex: number;
  } | undefined;
  /** The highest request index that was found to have a result. */
  highestResultRequestIndex: number;
}

/**
 * Parse JSONL content from a chat session file and determine the error state
 * of the most recent request.
 *
 * This is a pure function (no side effects, no VS Code API dependencies)
 * suitable for unit testing.
 */
export function parseSessionContent(content: string): ParsedSessionResult {
  const lines = content.split("\n").filter((line) => line.trim().length > 0);

  let latestError: ParsedSessionResult["latestError"];
  let highestResultRequestIndex = -1;

  for (const line of lines) {
    try {
      const entry: JsonlEntry = JSON.parse(line);
      processJsonlEntry(entry, (requestIndex, errorDetails) => {
        if (requestIndex >= highestResultRequestIndex) {
          highestResultRequestIndex = requestIndex;
          if (errorDetails) {
            latestError = {
              code: errorDetails.code ?? "unknown",
              message: errorDetails.message ?? "",
              hasRetryButton: hasRetryButton(errorDetails),
              requestIndex,
            };
          } else {
            // This request has a result WITHOUT an error — clears any previous error
            latestError = undefined;
          }
        }
      });
    } catch {
      // Malformed line (possible partial write) — skip
    }
  }

  return { latestError, highestResultRequestIndex };
}

/**
 * Process a single JSONL entry, calling the callback for each request result found.
 *
 * Supports all three JSONL entry kinds:
 *   - `kind: 0` — Full snapshot with `v.requests[]`
 *   - `kind: 1` — Key-path patch with `k: ["requests", N, "result"]`
 *   - `kind: 2` — Key replacement with `k: ["requests"]` and `v` as array
 *
 * @param callback - Called with (requestIndex, errorDetails | undefined) for each result found.
 */
export function processJsonlEntry(
  entry: JsonlEntry,
  callback: (
    requestIndex: number,
    errorDetails: ErrorDetails | undefined,
  ) => void,
): void {
  const kind = entry.kind;

  if (kind === 0) {
    // Full snapshot — check all requests
    const requests = entry.v?.requests;
    if (Array.isArray(requests)) {
      for (let i = 0; i < requests.length; i++) {
        const result = requests[i]?.result;
        if (result !== undefined) {
          callback(i, result?.errorDetails);
        }
      }
    }
  } else if (kind === 1) {
    // Key-path patch — look for ["requests", N, "result"]
    const keyPath = entry.k;
    if (
      Array.isArray(keyPath) &&
      keyPath.length === 3 &&
      keyPath[0] === "requests" &&
      typeof keyPath[1] === "number" &&
      keyPath[2] === "result"
    ) {
      const requestIndex = keyPath[1];
      const result = entry.v;
      callback(requestIndex, result?.errorDetails);
    }
  } else if (kind === 2) {
    // Key replacement — look for ["requests"] with a new array value
    const keyPath = entry.k;
    if (
      Array.isArray(keyPath) &&
      keyPath.length === 1 &&
      keyPath[0] === "requests" &&
      Array.isArray(entry.v)
    ) {
      const requests = entry.v;
      for (let i = 0; i < requests.length; i++) {
        const result = requests[i]?.result;
        if (result !== undefined) {
          callback(i, result?.errorDetails);
        }
      }
    }
  }
}

/**
 * Check if errorDetails has a "Try Again" button with copilotContinueOnError.
 * This is the same signal that Copilot's built-in "Try Again" button uses.
 */
export function hasRetryButton(errorDetails: ErrorDetails): boolean {
  const buttons = errorDetails.confirmationButtons;
  if (!Array.isArray(buttons)) {
    return false;
  }
  return buttons.some(
    (button: ConfirmationButton) =>
      button.data?.copilotContinueOnError === true,
  );
}

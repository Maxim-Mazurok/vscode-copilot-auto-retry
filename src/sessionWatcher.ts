import * as vscode from "vscode";
import { Logger } from "./logger";

/**
 * Watches Copilot chat session files on disk to detect when an agent session
 * has PAUSED and could be nudged forward with a continue message.
 *
 * VS Code persists chat sessions as JSONL files in:
 *   `workspaceStorage/<hash>/chatSessions/*.jsonl`
 *
 * Each line in a JSONL file is one of:
 *   - `kind: 0` — Full state snapshot (initial session state)
 *   - `kind: 1` — Key-path patch (e.g., set `requests[N].result` to a value)
 *   - `kind: 2` — Key replacement (e.g., replace entire `requests` array)
 *
 * When a request finishes, VS Code writes a `kind: 1` line with:
 *   `k: ["requests", N, "result"]`
 *   `v: { metadata: { ... } }`  (successful turn), or
 *   `v: { errorDetails: { code, message, confirmationButtons, ... } }`
 *
 * A session is considered PAUSED (a "continue opportunity") when either:
 *   1. The latest request has a `result` with no error — the agent's turn
 *      ended and it is idle, waiting to be told to keep going; or
 *   2. The latest request result carries a "continue"/"Try Again" style
 *      confirmation button (`copilotContinueOnError: true`) — the agent is
 *      explicitly asking whether it should keep iterating.
 *
 * The one exception is a `canceled` result, which means the user pressed Stop.
 * We never auto-continue those.
 *
 * This module watches those files and emits an event when a continue
 * opportunity is detected in the most recent request of any session.
 */

/** Describes a paused session that could be continued. */
export interface SessionPause {
  /** The session file where the pause was detected. */
  sessionId: string;
  /**
   * The reason we consider the session paused:
   *   - "turn-ended" — the latest request completed with no error
   *   - "continue-button" — the result carries a continue/Try Again button
   */
  reason: "turn-ended" | "continue-button";
  /** Copilot error/result code if one is present (e.g., "rateLimited"). */
  code: string;
  /** Human-readable detail about the pause. */
  message: string;
  /** Timestamp when we detected this pause. */
  detectedAt: number;
}

/**
 * Result codes that we should NOT auto-continue because they're user-initiated.
 * "canceled" typically means the user pressed the Stop button.
 */
export const NON_CONTINUABLE_CODES = new Set(["canceled"]);

/**
 * Debounce interval for filesystem watcher events (milliseconds).
 * VS Code may fire multiple change events for a single write operation.
 */
const WATCHER_DEBOUNCE_MS = 500;

/**
 * Polling interval (milliseconds) for the safety-net poller.
 *
 * VS Code's `createFileSystemWatcher` only reliably fires for paths INSIDE the
 * open workspace folders. Chat session files live in workspace/global storage,
 * which is outside the workspace — so the VS Code watcher is unreliable there.
 * A `fs.watch` covers most cases, but on some platforms it misses events, so we
 * also poll file mtimes as a guaranteed backstop.
 */
const POLL_INTERVAL_MS = 2000;

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

/**
 * Freshness window (milliseconds). A detected pause only triggers a continue if
 * the session file was modified — or the turn finished — within this window.
 * Prevents continuing turns that ended long ago when VS Code re-touches an old
 * session file (e.g., on window focus or session open).
 */
const PAUSE_FRESHNESS_WINDOW_MS = 120_000;

export class SessionWatcher implements vscode.Disposable {
  private fileWatcher: vscode.FileSystemWatcher | undefined;
  private nativeWatcher: import("fs").FSWatcher | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pauseListeners: Array<(pause: SessionPause) => void> = [];
  private readonly resumeListeners: Array<(sessionId: string) => void> = [];
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Tracks the last pause we detected per session to avoid duplicate triggers.
   * Key: session file name, Value: serialized pause signature.
   */
  private lastDetectedPauses = new Map<string, string>();

  /** Last-seen mtime per file, used by the polling backstop. */
  private lastPolledMtimes = new Map<string, number>();

  private chatSessionsDirectory: vscode.Uri | undefined;

  constructor(private readonly logger: Logger) {}

  /**
   * Subscribe to pause detection events (a session that could be continued).
   */
  onPauseDetected(listener: (pause: SessionPause) => void): void {
    this.pauseListeners.push(listener);
  }

  /**
   * Subscribe to resume events (a session that we previously paused now has a
   * newer in-flight request — i.e., the agent picked the work back up).
   */
  onResume(listener: (sessionId: string) => void): void {
    this.resumeListeners.push(listener);
  }

  /**
   * Returns true if at least one session in this workspace is currently
   * detected as paused (a continue opportunity that hasn't been acted on).
   */
  hasPendingPause(): boolean {
    return this.lastDetectedPauses.size > 0;
  }

  /**
   * Start watching chat session files.
   *
   * When a folder/workspace is open, sessions live in
   * `workspaceStorage/<hash>/chatSessions/` (reachable from the extension's
   * workspace `storageUri`). In an empty window (no folder open), sessions
   * live in `globalStorage/emptyWindowChatSessions/` (reachable from the
   * extension's `globalStorageUri`). We watch whichever applies.
   */
  async start(
    extensionStorageUri: vscode.Uri | undefined,
    extensionGlobalStorageUri?: vscode.Uri | undefined,
  ): Promise<void> {
    if (extensionStorageUri) {
      // workspaceStorage/<hash>/<ext-id>/ → workspaceStorage/<hash>/chatSessions/
      const workspaceStorageRoot = vscode.Uri.joinPath(
        extensionStorageUri,
        "..",
      );
      this.chatSessionsDirectory = vscode.Uri.joinPath(
        workspaceStorageRoot,
        "chatSessions",
      );
    } else if (extensionGlobalStorageUri) {
      // globalStorage/<ext-id>/ → globalStorage/emptyWindowChatSessions/
      const globalStorageRoot = vscode.Uri.joinPath(
        extensionGlobalStorageUri,
        "..",
      );
      this.chatSessionsDirectory = vscode.Uri.joinPath(
        globalStorageRoot,
        "emptyWindowChatSessions",
      );
    } else {
      this.logger.warn(
        "No workspace or global storage URI available — session watcher cannot start",
      );
      return;
    }

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

    // Baseline existing sessions BEFORE starting native watchers/poller so the
    // poller has a correct mtime baseline and nothing fires on startup.
    await this.performInitialScan();

    // The VS Code watcher above is unreliable for out-of-workspace paths, so
    // also start a native fs.watch and a polling backstop.
    await this.startNativeWatchers();
  }

  /**
   * Start a native `fs.watch` on the sessions directory plus a polling
   * backstop. These cover the common case where VS Code's FileSystemWatcher
   * does not fire for storage paths outside the open workspace.
   */
  private async startNativeWatchers(): Promise<void> {
    if (!this.chatSessionsDirectory) {
      return;
    }
    const directoryPath = this.chatSessionsDirectory.fsPath;
    const nodeFs = await import("fs");

    try {
      this.nativeWatcher = nodeFs.watch(
        directoryPath,
        { persistent: false },
        (_eventType, fileName) => {
          if (!fileName) {
            return;
          }
          const name = fileName.toString();
          if (!name.endsWith(".jsonl") || !this.chatSessionsDirectory) {
            return;
          }
          const uri = vscode.Uri.joinPath(this.chatSessionsDirectory, name);
          this.handleFileChange(uri);
        },
      );
      this.logger.info(`Native fs.watch active on ${directoryPath}`);
    } catch (watchError) {
      this.logger.debug(
        `Native fs.watch unavailable (${watchError instanceof Error ? watchError.message : String(watchError)}) — relying on poller`,
      );
    }

    // Seed the poll baseline so the first poll doesn't rescan everything.
    await this.seedPollBaseline();

    this.pollTimer = setInterval(() => {
      void this.pollForChanges();
    }, POLL_INTERVAL_MS);
    this.logger.info(
      `Polling backstop active (every ${POLL_INTERVAL_MS}ms) on ${directoryPath}`,
    );
  }

  /** Record current mtimes so the first poll only reacts to real changes. */
  private async seedPollBaseline(): Promise<void> {
    if (!this.chatSessionsDirectory) {
      return;
    }
    try {
      const entries = await vscode.workspace.fs.readDirectory(
        this.chatSessionsDirectory,
      );
      for (const [name, type] of entries) {
        if (!name.endsWith(".jsonl") || type !== vscode.FileType.File) {
          continue;
        }
        const uri = vscode.Uri.joinPath(this.chatSessionsDirectory, name);
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          this.lastPolledMtimes.set(name, stat.mtime);
        } catch {
          // ignore
        }
      }
    } catch {
      // directory may not exist yet
    }
  }

  /**
   * Poll the sessions directory for new or modified files and rescan them.
   * This is the guaranteed backstop when event-based watchers miss changes.
   */
  private async pollForChanges(): Promise<void> {
    if (!this.chatSessionsDirectory) {
      return;
    }
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(
        this.chatSessionsDirectory,
      );
    } catch {
      return;
    }

    for (const [name, type] of entries) {
      if (!name.endsWith(".jsonl") || type !== vscode.FileType.File) {
        continue;
      }
      const uri = vscode.Uri.joinPath(this.chatSessionsDirectory, name);
      let mtime: number;
      try {
        mtime = (await vscode.workspace.fs.stat(uri)).mtime;
      } catch {
        continue;
      }
      const previous = this.lastPolledMtimes.get(name);
      if (previous === undefined || mtime > previous) {
        this.lastPolledMtimes.set(name, mtime);
        this.handleFileChange(uri);
      }
    }
  }

  /**
   * Stop watching session files.
   */
  stop(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    if (this.nativeWatcher) {
      this.nativeWatcher.close();
      this.nativeWatcher = undefined;
    }
    this.lastPolledMtimes.clear();

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
    this.logger.debug(`Session file change detected: ${fileName}`);

    // Debounce: VS Code may fire multiple events for a single write
    const existingTimer = this.debounceTimers.get(fileName);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    this.debounceTimers.set(
      fileName,
      setTimeout(() => {
        this.debounceTimers.delete(fileName);
        this.logger.debug(`Debounce elapsed — scanning ${fileName}`);
        void this.scanSessionFile(uri);
      }, WATCHER_DEBOUNCE_MS),
    );
  }

  /**
   * Baseline every existing session file on startup.
   *
   * All current sessions are recorded WITHOUT emitting, so a paused/completed
   * session that already existed before the extension started never triggers a
   * continue. Only *new* transitions into a paused state (detected by the live
   * file watcher afterwards) fire a continue.
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

      this.logger.info(
        `Initial scan: baselining ${jsonlFiles.length} existing session file(s)`,
      );

      for (const fileName of jsonlFiles) {
        const fileUri = vscode.Uri.joinPath(
          this.chatSessionsDirectory,
          fileName,
        );
        // Baseline only — record current state, never emit on startup.
        await this.scanSessionFile(fileUri, true);
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
  private async scanSessionFile(
    fileUri: vscode.Uri,
    suppressEmit = false,
  ): Promise<void> {
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
      this.processSessionContent(
        sessionId,
        content,
        suppressEmit,
        fileStat.mtime,
      );
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

    // Large file — try the tail first as an optimisation.
    const nodeFilesystem = await import("fs/promises");
    const tailContent = await this.readFileTail(
      nodeFilesystem,
      fileUri.fsPath,
      fileSize,
    );

    // The tail only yields a usable state if it contains a base entry
    // (kind 0 snapshot or kind 2 requests replacement) — otherwise the
    // requests array can't be reconstructed. Single-line sessions (common in
    // empty windows) and large trailing result entries both fail the tail;
    // in those cases we read the full file. This correctness-first fallback
    // guarantees we never miss a pause due to windowing.
    const parsed = parseSessionContent(tailContent);
    if (parsed.highestResultRequestIndex >= 0) {
      return tailContent;
    }

    this.logger.debug(
      `Tail of session ${sessionId} lacked a reconstructable state — reading full file`,
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
  /**
   * Classify a session's current state and, unless suppressed, emit a pause or
   * resume event.
   *
   * @param suppressEmit - When true (initial baseline scan), the current pause
   *   signature is recorded WITHOUT emitting. This ensures pre-existing
   *   completed/paused sessions never trigger a continue just because the
   *   extension started or VS Code re-touched an old file.
   * @param fileModifiedMs - The file's mtime, used as a freshness gate so we
   *   never continue a turn that finished long ago.
   */
  private processSessionContent(
    sessionId: string,
    content: string,
    suppressEmit: boolean,
    fileModifiedMs: number,
  ): void {
    const parsedResult = parseSessionContent(content);
    const latestPause = parsedResult?.latestPause;

    const previousPause = this.lastDetectedPauses.get(sessionId);
    // Include the turn's finish timestamp so each distinct completed turn is a
    // unique pause — VS Code reuses the same request index (requests[0]) and
    // replaces it in place across turns, so index+reason+code alone repeats.
    const currentPauseSignature = latestPause
      ? `${latestPause.requestIndex}:${latestPause.reason}:${latestPause.code}:${latestPause.finishedAt ?? "?"}`
      : undefined;

    this.logger.debug(
      `Scan ${sessionId}: ${suppressEmit ? "[baseline] " : ""}` +
      `parsed=${latestPause ? `${latestPause.reason}/${latestPause.code}@req${latestPause.requestIndex}` : "no-pause"}, ` +
      `sig=${currentPauseSignature ?? "none"}, prevSig=${previousPause ?? "none"}, ` +
      `mtimeAgo=${Math.round((Date.now() - fileModifiedMs) / 1000)}s`,
    );

    // Baseline mode: record the current state and never emit.
    if (suppressEmit) {
      if (currentPauseSignature) {
        this.lastDetectedPauses.set(sessionId, currentPauseSignature);
      } else {
        this.lastDetectedPauses.delete(sessionId);
      }
      return;
    }

    if (latestPause) {
      if (currentPauseSignature === previousPause) {
        this.logger.debug(
          `Same pause still present in session ${sessionId} — not re-triggering`,
        );
        return;
      }

      // Freshness gate: reject completions that are clearly stale. We consider
      // a pause fresh if either the file was just modified OR the turn's own
      // finish timestamp is recent. This blocks spurious continues when VS Code
      // re-touches an old finished session file.
      if (!this.isPauseFresh(latestPause.finishedAt, fileModifiedMs)) {
        this.logger.debug(
          `Pause in session ${sessionId} is stale — recording baseline, not continuing`,
        );
        this.lastDetectedPauses.set(sessionId, currentPauseSignature!);
        return;
      }

      this.lastDetectedPauses.set(sessionId, currentPauseSignature!);

      const sessionPause: SessionPause = {
        sessionId,
        reason: latestPause.reason,
        code: latestPause.code,
        message: latestPause.message,
        detectedAt: Date.now(),
      };

      this.logger.info(
        `Pause detected in session ${sessionId}: ` +
        `reason=${latestPause.reason}, code=${latestPause.code}, ` +
        `request #${latestPause.requestIndex}`,
      );

      this.emitPauseDetected(sessionPause);
    } else if (previousPause) {
      // The session was paused but now has a newer in-flight request —
      // the agent picked the work back up.
      this.lastDetectedPauses.delete(sessionId);
      this.logger.info(
        `Session ${sessionId} resumed — a newer request is in flight`,
      );
      this.emitResume(sessionId);
    }
  }

  /**
   * A pause is fresh if the file was modified within the freshness window, or
   * the turn's own finish timestamp is within it. Missing timestamps fall back
   * to the file mtime so live sessions are never wrongly rejected.
   */
  private isPauseFresh(
    finishedAt: number | undefined,
    fileModifiedMs: number,
  ): boolean {
    const now = Date.now();
    if (now - fileModifiedMs <= PAUSE_FRESHNESS_WINDOW_MS) {
      return true;
    }
    if (
      typeof finishedAt === "number" &&
      now - finishedAt <= PAUSE_FRESHNESS_WINDOW_MS
    ) {
      return true;
    }
    return false;
  }

  private emitPauseDetected(pause: SessionPause): void {
    for (const listener of this.pauseListeners) {
      try {
        listener(pause);
      } catch (listenerError) {
        this.logger.error(
          `Session pause listener threw: ${listenerError instanceof Error ? listenerError.message : String(listenerError)}`,
        );
      }
    }
  }

  private emitResume(sessionId: string): void {
    for (const listener of this.resumeListeners) {
      try {
        listener(sessionId);
      } catch (listenerError) {
        this.logger.error(
          `Session resume listener threw: ${listenerError instanceof Error ? listenerError.message : String(listenerError)}`,
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
 * Contains the latest continue opportunity (if any) for the most recent request.
 */
export interface ParsedSessionResult {
  latestPause: {
    /** Why the session counts as paused. */
    reason: "turn-ended" | "continue-button";
    /** Result/error code, or "ok" for a clean turn-ended result. */
    code: string;
    message: string;
    requestIndex: number;
    /**
     * Best-effort wall-clock time (ms since epoch) that the turn finished,
     * derived from the request's `responseTimestamp`/`timestamp` or a result
     * tool-call round. Used to reject stale completions. `undefined` when no
     * timestamp is available.
     */
    finishedAt: number | undefined;
  } | undefined;
  /** The highest request index that was found to have a result. */
  highestResultRequestIndex: number;
}

/**
 * Minimal shape of a request object we care about, once the final `requests`
 * array has been reconstructed from all JSONL entries.
 */
interface RequestLike {
  result?: {
    errorDetails?: ErrorDetails;
    metadata?: {
      toolCallRounds?: Array<{ timestamp?: number }>;
    };
  };
  response?: unknown;
  isCanceled?: boolean;
  timestamp?: number;
  responseTimestamp?: number;
}

/**
 * Parse JSONL content from a chat session file and determine whether the most
 * recent request represents a continue opportunity.
 *
 * Strategy: reconstruct the *final* `requests` array by replaying every JSONL
 * entry in order (kind 0 sets the base, kind 2 replaces a key, kind 1 patches a
 * single result), then classify only the last request. Reconstructing the true
 * end state — rather than picking the "highest index seen" — makes detection
 * robust to interleaved snapshots, array replacements, and per-result patches.
 *
 * This is a pure function (no side effects, no VS Code API dependencies)
 * suitable for unit testing.
 */
export function parseSessionContent(content: string): ParsedSessionResult {
  const lines = content.split("\n").filter((line) => line.trim().length > 0);

  let requests: RequestLike[] | undefined;

  for (const line of lines) {
    let entry: JsonlEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      // Malformed line (possible partial write) — skip
      continue;
    }
    requests = applyEntryToRequests(entry, requests);
  }

  if (!requests || requests.length === 0) {
    return { latestPause: undefined, highestResultRequestIndex: -1 };
  }

  // Find the last request that actually has a result.
  let lastResultIndex = -1;
  for (let i = requests.length - 1; i >= 0; i--) {
    if (requests[i]?.result !== undefined) {
      lastResultIndex = i;
      break;
    }
  }

  if (lastResultIndex < 0) {
    return { latestPause: undefined, highestResultRequestIndex: -1 };
  }

  const latestPause = classifyPause(lastResultIndex, requests[lastResultIndex]);
  return { latestPause, highestResultRequestIndex: lastResultIndex };
}

/**
 * Apply one JSONL entry to the running `requests` reconstruction and return the
 * updated array reference.
 */
function applyEntryToRequests(
  entry: JsonlEntry,
  requests: RequestLike[] | undefined,
): RequestLike[] | undefined {
  const kind = entry.kind;

  if (kind === 0) {
    const snapshotRequests = entry.v?.requests;
    return Array.isArray(snapshotRequests) ? snapshotRequests : requests;
  }

  if (kind === 2) {
    const keyPath = entry.k;
    if (
      Array.isArray(keyPath) &&
      keyPath.length === 1 &&
      keyPath[0] === "requests" &&
      Array.isArray(entry.v)
    ) {
      return entry.v as RequestLike[];
    }
    return requests;
  }

  if (kind === 1) {
    const keyPath = entry.k;
    if (
      Array.isArray(keyPath) &&
      keyPath.length === 3 &&
      keyPath[0] === "requests" &&
      typeof keyPath[1] === "number" &&
      keyPath[2] === "result"
    ) {
      const index = keyPath[1];
      if (index >= 0) {
        // Grow the array if a result patch references an index we haven't seen
        // yet (e.g., the base snapshot is outside a tail read, or absent).
        const grown = requests ? [...requests] : [];
        while (grown.length <= index) {
          grown.push({});
        }
        grown[index] = { ...grown[index], result: entry.v };
        return grown;
      }
    }
    return requests;
  }

  return requests;
}

/**
 * Extract the best-effort finish time for a completed request.
 */
function extractFinishedAt(request: RequestLike): number | undefined {
  if (typeof request.responseTimestamp === "number") {
    return request.responseTimestamp;
  }
  const rounds = request.result?.metadata?.toolCallRounds;
  if (Array.isArray(rounds)) {
    for (let i = rounds.length - 1; i >= 0; i--) {
      const ts = rounds[i]?.timestamp;
      if (typeof ts === "number") {
        return ts;
      }
    }
  }
  if (typeof request.timestamp === "number") {
    return request.timestamp;
  }
  return undefined;
}

/**
 * Decide whether a completed request is a continue opportunity.
 * Returns undefined when it should not be auto-continued (a non-button error,
 * a user cancellation, or a still-in-flight request).
 */
function classifyPause(
  requestIndex: number,
  request: RequestLike,
): ParsedSessionResult["latestPause"] {
  const result = request.result;
  if (!result) {
    return undefined;
  }

  const finishedAt = extractFinishedAt(request);
  const errorDetails = result.errorDetails;

  if (!errorDetails) {
    // A user-cancelled turn can still land a clean result — never continue it.
    if (request.isCanceled === true) {
      return undefined;
    }
    // Clean turn-ended result — the agent is idle and can be nudged onward.
    return {
      reason: "turn-ended",
      code: "ok",
      message: "",
      requestIndex,
      finishedAt,
    };
  }

  const code = errorDetails.code ?? "unknown";

  if (NON_CONTINUABLE_CODES.has(code)) {
    // User pressed Stop — never auto-continue.
    return undefined;
  }

  if (hasContinueButton(errorDetails)) {
    return {
      reason: "continue-button",
      code,
      message: errorDetails.message ?? "",
      requestIndex,
      finishedAt,
    };
  }

  // An error without a continue button — nothing we can nudge.
  return undefined;
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
 * Check if errorDetails has a continue/"Try Again" button with
 * `copilotContinueOnError`. This is the same signal that Copilot's built-in
 * "Try Again"/continue button uses.
 */
export function hasContinueButton(errorDetails: ErrorDetails): boolean {
  const buttons = errorDetails.confirmationButtons;
  if (!Array.isArray(buttons)) {
    return false;
  }
  return buttons.some(
    (button: ConfirmationButton) =>
      button.data?.copilotContinueOnError === true,
  );
}

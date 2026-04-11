import * as vscode from "vscode";
import { execFile } from "child_process";
import { Logger } from "./logger";

/**
 * Resolves the currently active (visible) chat session in this VS Code window.
 *
 * VS Code stores the active session ID in `state.vscdb` (a SQLite database)
 * under the key `memento/interactive-session-view-copilot`. The value is a
 * JSON object with a `sessionId` field matching the JSONL filename.
 *
 * We read this value by shelling out to the `sqlite3` CLI, which is
 * pre-installed on macOS (always) and most Linux distributions. On systems
 * where `sqlite3` is not available, we gracefully skip the check and return
 * `undefined` (meaning "assume the correct session is active").
 *
 * This is used as a safety gate: before submitting a retry, we verify that
 * the errored session is still the one shown in the chat panel. If the user
 * switched to a different session, we skip the retry to avoid submitting a
 * retry prompt into the wrong conversation.
 */

/** Timeout for the sqlite3 CLI call (milliseconds). */
const SQLITE_QUERY_TIMEOUT_MS = 3_000;

const STATE_DB_KEY = "memento/interactive-session-view-copilot";

export class ActiveSessionResolver {
	private databasePath: string | undefined;

	constructor(private readonly logger: Logger) {}

	/**
	 * Initialize with the extension storage URI. Derives the path to state.vscdb.
	 */
	initialize(extensionStorageUri: vscode.Uri | undefined): void {
		if (!extensionStorageUri) {
			this.logger.warn(
				"ActiveSessionResolver: no workspace storage URI — session verification disabled",
			);
			return;
		}

		// Navigate: workspaceStorage/<hash>/<ext-id>/ → workspaceStorage/<hash>/state.vscdb
		const workspaceStorageRoot = vscode.Uri.joinPath(extensionStorageUri, "..");
		const databaseUri = vscode.Uri.joinPath(workspaceStorageRoot, "state.vscdb");
		this.databasePath = databaseUri.fsPath;

		this.logger.debug(
			`ActiveSessionResolver initialized: ${this.databasePath}`,
		);
	}

	/**
	 * Query the currently active chat session ID from state.vscdb.
	 *
	 * Returns:
	 * - The session UUID string if the active session can be determined
	 * - `undefined` if the check cannot be performed (no db path, sqlite3
	 *   not available, parse error, etc.) — caller should proceed as if
	 *   the correct session is active (graceful degradation)
	 */
	async getActiveSessionId(): Promise<string | undefined> {
		if (!this.databasePath) {
			return undefined;
		}

		try {
			const rawValue = await this.querySqliteValue(
				this.databasePath,
				STATE_DB_KEY,
			);

			if (!rawValue) {
				return undefined;
			}

			const parsed = JSON.parse(rawValue);

			// Try old format first (direct sessionId field)
			const sessionId = parsed?.sessionId;
			if (typeof sessionId === "string" && sessionId.length > 0) {
				return sessionId;
			}

			// Try new format (sessionResource.path contains Base64-encoded session ID)
			const sessionResourcePath = parsed?.sessionResource?.path;
			if (typeof sessionResourcePath === "string" && sessionResourcePath.length > 0) {
				// Path is like "/OTYxZjRmNGYtMzdhYS00ODY0LThlZjEtNjBlYjdmMjJhYWE2"
				// Strip leading slash and decode Base64
				const base64Id = sessionResourcePath.startsWith("/")
					? sessionResourcePath.slice(1)
					: sessionResourcePath;

				try {
					const decoded = Buffer.from(base64Id, "base64").toString("utf-8");
					// Validate it looks like a UUID
					if (decoded.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
						return decoded;
					}
				} catch {
					// Invalid Base64, fall through
				}
			}

			this.logger.debug(
				"ActiveSessionResolver: sessionId not found or empty in state.vscdb value",
			);
			return undefined;
		} catch (error) {
			this.logger.debug(
				`ActiveSessionResolver: failed to read active session: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return undefined;
		}
	}

	/**
	 * Check whether a given session ID is currently the active (visible)
	 * session in the chat panel.
	 *
	 * Returns `true` if:
	 * - The session IS confirmed active, OR
	 * - We cannot determine the active session (graceful degradation — assume yes)
	 *
	 * Returns `false` only when we can positively confirm that a DIFFERENT
	 * session is active.
	 */
	async isSessionActive(sessionId: string): Promise<boolean> {
		const activeSessionId = await this.getActiveSessionId();

		if (activeSessionId === undefined) {
			// Cannot determine — gracefully assume the correct session is active
			this.logger.debug(
				"ActiveSessionResolver: could not determine active session — proceeding",
			);
			return true;
		}

		if (activeSessionId === sessionId) {
			return true;
		}

		this.logger.info(
			`ActiveSessionResolver: session mismatch — ` +
			`errored session=${sessionId}, ` +
			`active session=${activeSessionId}. ` +
			`Skipping retry to avoid submitting to wrong conversation.`,
		);
		return false;
	}

	/**
	 * Execute a sqlite3 CLI query to read a single value from the ItemTable.
	 *
	 * Returns the raw value string, or undefined if the query fails.
	 */
	private querySqliteValue(
		databaseFilePath: string,
		key: string,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			const query = `SELECT value FROM ItemTable WHERE key = '${key}' LIMIT 1;`;

			execFile(
				"sqlite3",
				["-readonly", databaseFilePath, query],
				{ timeout: SQLITE_QUERY_TIMEOUT_MS },
				(error, stdout) => {
					if (error) {
						// sqlite3 not found, db locked, or other error — graceful degradation
						this.logger.debug(
							`ActiveSessionResolver: sqlite3 query failed: ${error.message}`,
						);
						resolve(undefined);
						return;
					}

					const trimmed = stdout.trim();
					if (trimmed.length === 0) {
						resolve(undefined);
						return;
					}

					resolve(trimmed);
				},
			);
		});
	}
}

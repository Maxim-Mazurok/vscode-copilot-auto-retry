import { describe, expect, it, vi, beforeEach } from "vitest";
import { Uri } from "vscode";
import { ActiveSessionResolver } from "./activeSessionResolver";
import { Logger } from "./logger";

/**
 * Mock child_process.execFile so we can simulate sqlite3 CLI output.
 *
 * The real execFile signature we use is:
 *   execFile(command, args, options, callback) → ChildProcess
 */
vi.mock("child_process", () => ({
	execFile: vi.fn(),
}));

import { execFile } from "child_process";

const mockedExecFile = vi.mocked(execFile);

function createResolver(): ActiveSessionResolver {
	const logger = new Logger();
	return new ActiveSessionResolver(logger);
}

/**
 * Configure the execFile mock to simulate a successful sqlite3 invocation
 * that writes `stdout` to the callback.
 */
function simulateSqliteOutput(stdout: string): void {
	mockedExecFile.mockImplementation(
		(_command: unknown, _arguments: unknown, _options: unknown, callback: unknown) => {
			(callback as (error: Error | null, stdout: string, stderr: string) => void)(null, stdout, "");
			return undefined as never;
		},
	);
}

/**
 * Configure the execFile mock to simulate a failed sqlite3 invocation
 * (e.g., sqlite3 not installed or database locked).
 */
function simulateSqliteError(error: Error): void {
	mockedExecFile.mockImplementation(
		(_command: unknown, _arguments: unknown, _options: unknown, callback: unknown) => {
			(callback as (error: Error | null, stdout: string, stderr: string) => void)(error, "", "");
			return undefined as never;
		},
	);
}

/* ═══════════════════════════════ Tests ═══════════════════════════════════ */

describe("ActiveSessionResolver", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("initialize", () => {
		it("derives database path from extension storage URI", () => {
			const resolver = createResolver();
			const storageUri = Uri.file(
				"/Users/test/Library/Application Support/Code/User/workspaceStorage/abc123/my-extension",
			);

			// Should not throw
			expect(() => resolver.initialize(storageUri)).not.toThrow();
		});

		it("handles undefined storage URI gracefully", () => {
			const resolver = createResolver();

			// Should not throw — just disables session verification
			expect(() => resolver.initialize(undefined)).not.toThrow();
		});

		it("returns undefined from getActiveSessionId when no storage URI was provided", async () => {
			const resolver = createResolver();
			resolver.initialize(undefined);

			const sessionId = await resolver.getActiveSessionId();

			expect(sessionId).toBeUndefined();
			expect(mockedExecFile).not.toHaveBeenCalled();
		});
	});

	describe("getActiveSessionId", () => {
		it("returns session ID from valid sqlite3 output", async () => {
			const resolver = createResolver();
			resolver.initialize(
				Uri.file("/Users/test/workspaceStorage/abc123/extension-id"),
			);

			simulateSqliteOutput(
				'{"sessionId":"f729284b-c3a0-439e-b39b-7e2c55f1696c"}',
			);

			const sessionId = await resolver.getActiveSessionId();

			expect(sessionId).toBe("f729284b-c3a0-439e-b39b-7e2c55f1696c");
		});

		it("returns undefined when sqlite3 returns empty output", async () => {
			const resolver = createResolver();
			resolver.initialize(
				Uri.file("/Users/test/workspaceStorage/abc123/extension-id"),
			);

			simulateSqliteOutput("");

			const sessionId = await resolver.getActiveSessionId();

			expect(sessionId).toBeUndefined();
		});

		it("returns undefined when sqlite3 returns whitespace-only output", async () => {
			const resolver = createResolver();
			resolver.initialize(
				Uri.file("/Users/test/workspaceStorage/abc123/extension-id"),
			);

			simulateSqliteOutput("   \n  ");

			const sessionId = await resolver.getActiveSessionId();

			expect(sessionId).toBeUndefined();
		});

		it("returns undefined when sqlite3 is not available (ENOENT)", async () => {
			const resolver = createResolver();
			resolver.initialize(
				Uri.file("/Users/test/workspaceStorage/abc123/extension-id"),
			);

			simulateSqliteError(new Error("spawn sqlite3 ENOENT"));

			const sessionId = await resolver.getActiveSessionId();

			expect(sessionId).toBeUndefined();
		});

		it("returns undefined when sqlite3 output is invalid JSON", async () => {
			const resolver = createResolver();
			resolver.initialize(
				Uri.file("/Users/test/workspaceStorage/abc123/extension-id"),
			);

			simulateSqliteOutput("not valid json at all");

			const sessionId = await resolver.getActiveSessionId();

			expect(sessionId).toBeUndefined();
		});

		it("returns undefined when JSON has no sessionId field", async () => {
			const resolver = createResolver();
			resolver.initialize(
				Uri.file("/Users/test/workspaceStorage/abc123/extension-id"),
			);

			simulateSqliteOutput('{"otherField":"value","count":42}');

			const sessionId = await resolver.getActiveSessionId();

			expect(sessionId).toBeUndefined();
		});

		it("returns undefined when sessionId is an empty string", async () => {
			const resolver = createResolver();
			resolver.initialize(
				Uri.file("/Users/test/workspaceStorage/abc123/extension-id"),
			);

			simulateSqliteOutput('{"sessionId":""}');

			const sessionId = await resolver.getActiveSessionId();

			expect(sessionId).toBeUndefined();
		});

		it("returns undefined when sessionId is not a string", async () => {
			const resolver = createResolver();
			resolver.initialize(
				Uri.file("/Users/test/workspaceStorage/abc123/extension-id"),
			);

			simulateSqliteOutput('{"sessionId":12345}');

			const sessionId = await resolver.getActiveSessionId();

			expect(sessionId).toBeUndefined();
		});

		it("passes correct arguments to sqlite3 CLI", async () => {
			const resolver = createResolver();
			resolver.initialize(
				Uri.file("/Users/test/workspaceStorage/abc123/extension-id"),
			);

			simulateSqliteOutput('{"sessionId":"some-id"}');

			await resolver.getActiveSessionId();

			expect(mockedExecFile).toHaveBeenCalledOnce();
			const callArguments = mockedExecFile.mock.calls[0];
			// First arg: command
			expect(callArguments[0]).toBe("sqlite3");
			// Second arg: arguments array
			const cliArguments = callArguments[1] as string[];
			expect(cliArguments).toContain("-readonly");
			expect(
				cliArguments.some((argument: string) =>
					argument.includes("state.vscdb"),
				),
			).toBe(true);
			expect(
				cliArguments.some((argument: string) =>
					argument.includes("memento/interactive-session-view-copilot"),
				),
			).toBe(true);
		});

		it("uses timeout option for sqlite3 execution", async () => {
			const resolver = createResolver();
			resolver.initialize(
				Uri.file("/Users/test/workspaceStorage/abc123/extension-id"),
			);

			simulateSqliteOutput('{"sessionId":"some-id"}');

			await resolver.getActiveSessionId();

			const callOptions = mockedExecFile.mock.calls[0][2] as {
				timeout: number;
			};
			expect(callOptions.timeout).toBe(3_000);
		});
	});

	describe("isSessionActive", () => {
		it("returns true when the given session matches the active session", async () => {
			const resolver = createResolver();
			resolver.initialize(
				Uri.file("/Users/test/workspaceStorage/abc123/extension-id"),
			);

			const targetSessionId = "f729284b-c3a0-439e-b39b-7e2c55f1696c";
			simulateSqliteOutput(`{"sessionId":"${targetSessionId}"}`);

			const isActive = await resolver.isSessionActive(targetSessionId);

			expect(isActive).toBe(true);
		});

		it("returns false when a different session is active", async () => {
			const resolver = createResolver();
			resolver.initialize(
				Uri.file("/Users/test/workspaceStorage/abc123/extension-id"),
			);

			simulateSqliteOutput('{"sessionId":"different-session-id"}');

			const isActive = await resolver.isSessionActive(
				"my-errored-session-id",
			);

			expect(isActive).toBe(false);
		});

		it("returns true (graceful degradation) when sqlite3 is unavailable", async () => {
			const resolver = createResolver();
			resolver.initialize(
				Uri.file("/Users/test/workspaceStorage/abc123/extension-id"),
			);

			simulateSqliteError(new Error("sqlite3 not found"));

			const isActive =
				await resolver.isSessionActive("any-session-id");

			expect(isActive).toBe(true);
		});

		it("returns true (graceful degradation) when no storage URI was configured", async () => {
			const resolver = createResolver();
			resolver.initialize(undefined);

			const isActive =
				await resolver.isSessionActive("any-session-id");

			expect(isActive).toBe(true);
		});

		it("returns true (graceful degradation) when JSON parse fails", async () => {
			const resolver = createResolver();
			resolver.initialize(
				Uri.file("/Users/test/workspaceStorage/abc123/extension-id"),
			);

			simulateSqliteOutput("corrupted data {{{{");

			const isActive =
				await resolver.isSessionActive("any-session-id");

			expect(isActive).toBe(true);
		});

		it("returns true (graceful degradation) when database returns empty result", async () => {
			const resolver = createResolver();
			resolver.initialize(
				Uri.file("/Users/test/workspaceStorage/abc123/extension-id"),
			);

			simulateSqliteOutput("");

			const isActive =
				await resolver.isSessionActive("any-session-id");

			expect(isActive).toBe(true);
		});
	});
});

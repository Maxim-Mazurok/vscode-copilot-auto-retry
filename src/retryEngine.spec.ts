import { describe, expect, it } from "vitest";
import { RetryEngine } from "./retryEngine";
import type { SessionError } from "./sessionWatcher";

/* ═══════════════════════════════ Tests ═══════════════════════════════════ */

describe("RetryEngine — trigger factories", () => {
	describe("triggerFromSessionError", () => {
		it("creates a session-error trigger with correct fields", () => {
			const sessionError: SessionError = {
				sessionId: "f729284b-c3a0-439e-b39b-7e2c55f1696c",
				errorCode: "networkError",
				message:
					"Sorry, there was a network error. Please try again later.",
				hasRetryButton: true,
				detectedAt: 1_700_000_000_000,
			};

			const trigger = RetryEngine.triggerFromSessionError(sessionError);

			expect(trigger.source).toBe("session-error");
			expect(trigger.errorCode).toBe("networkError");
			expect(trigger.sessionId).toBe(
				"f729284b-c3a0-439e-b39b-7e2c55f1696c",
			);
			expect(trigger.timestamp).toBe(1_700_000_000_000);
			expect(trigger.detail).toContain("f729284b");
			expect(trigger.detail).toContain("network error");
		});

		it("truncates long messages in the detail field", () => {
			const longMessage = "A".repeat(200);
			const sessionError: SessionError = {
				sessionId: "some-session-id",
				errorCode: "rateLimited",
				message: longMessage,
				hasRetryButton: true,
				detectedAt: Date.now(),
			};

			const trigger = RetryEngine.triggerFromSessionError(sessionError);

			// Detail should be: "Session <sessionId>: <120 chars of message>"
			// Total should be well under 200 chars
			expect(trigger.detail.length).toBeLessThan(200);
		});

		it("preserves the session ID for active-session verification", () => {
			const sessionError: SessionError = {
				sessionId: "82e4b7e4-4d8d-442e-a44b-f99ce5f9e1af",
				errorCode: "rateLimited",
				message: "Rate limited",
				hasRetryButton: true,
				detectedAt: Date.now(),
			};

			const trigger = RetryEngine.triggerFromSessionError(sessionError);

			expect(trigger.sessionId).toBe(
				"82e4b7e4-4d8d-442e-a44b-f99ce5f9e1af",
			);
		});
	});

	describe("triggerFromNetworkRecovery", () => {
		it("creates a network-recovery trigger", () => {
			const before = Date.now();
			const trigger = RetryEngine.triggerFromNetworkRecovery();
			const after = Date.now();

			expect(trigger.source).toBe("network-recovery");
			expect(trigger.errorCode).toBeUndefined();
			expect(trigger.sessionId).toBeUndefined();
			expect(trigger.timestamp).toBeGreaterThanOrEqual(before);
			expect(trigger.timestamp).toBeLessThanOrEqual(after);
			expect(trigger.detail).toContain("Network");
		});

		it("does not include a sessionId (network recovery is window-wide)", () => {
			const trigger = RetryEngine.triggerFromNetworkRecovery();

			expect(trigger.sessionId).toBeUndefined();
		});
	});

	describe("triggerFromManualAction", () => {
		it("creates a manual trigger", () => {
			const before = Date.now();
			const trigger = RetryEngine.triggerFromManualAction();
			const after = Date.now();

			expect(trigger.source).toBe("manual");
			expect(trigger.errorCode).toBeUndefined();
			expect(trigger.sessionId).toBeUndefined();
			expect(trigger.timestamp).toBeGreaterThanOrEqual(before);
			expect(trigger.timestamp).toBeLessThanOrEqual(after);
			expect(trigger.detail).toContain("Manual");
		});

		it("does not include a sessionId (manual triggers bypass session check)", () => {
			const trigger = RetryEngine.triggerFromManualAction();

			expect(trigger.sessionId).toBeUndefined();
		});
	});
});

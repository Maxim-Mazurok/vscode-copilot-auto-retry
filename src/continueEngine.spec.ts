import { describe, expect, it } from "vitest";
import { ContinueEngine, buildLocalChatSessionUri } from "./continueEngine";
import type { SessionPause } from "./sessionWatcher";

/* ═══════════════════════════════ Tests ═══════════════════════════════════ */

describe("buildLocalChatSessionUri", () => {
	it("builds a base64url-encoded local chat session URI", () => {
		const uri = buildLocalChatSessionUri(
			"aa74e8ef-4a3c-4163-aaa9-9eaddd5747e2",
		);
		expect(uri.scheme).toBe("vscode-chat-session");
		expect(uri.authority).toBe("local");
		// base64url of the UUID, no padding
		expect(uri.path).toBe(
			"/YWE3NGU4ZWYtNGEzYy00MTYzLWFhYTktOWVhZGRkNTc0N2Uy",
		);
	});

	it("round-trips the session id through base64url", () => {
		const id = "12345678-90ab-cdef-1234-567890abcdef";
		const uri = buildLocalChatSessionUri(id);
		const encoded = uri.path.slice(1);
		const decoded = Buffer.from(
			encoded.replace(/-/g, "+").replace(/_/g, "/"),
			"base64",
		).toString("utf-8");
		expect(decoded).toBe(id);
	});
});

describe("ContinueEngine — trigger factories", () => {
	describe("triggerFromSessionPause", () => {
		it("creates a session-pause trigger with correct fields", () => {
			const pause: SessionPause = {
				sessionId: "f729284b-c3a0-439e-b39b-7e2c55f1696c",
				reason: "turn-ended",
				code: "ok",
				message: "",
				detectedAt: 1_700_000_000_000,
			};

			const trigger = ContinueEngine.triggerFromSessionPause(pause);

			expect(trigger.source).toBe("session-pause");
			expect(trigger.reason).toBe("turn-ended");
			expect(trigger.sessionId).toBe(
				"f729284b-c3a0-439e-b39b-7e2c55f1696c",
			);
			expect(trigger.timestamp).toBe(1_700_000_000_000);
			expect(trigger.detail).toContain("f729284b");
		});

		it("preserves the session ID for active-session verification", () => {
			const pause: SessionPause = {
				sessionId: "82e4b7e4-4d8d-442e-a44b-f99ce5f9e1af",
				reason: "continue-button",
				code: "rateLimited",
				message: "Rate limited",
				detectedAt: Date.now(),
			};

			const trigger = ContinueEngine.triggerFromSessionPause(pause);

			expect(trigger.sessionId).toBe(
				"82e4b7e4-4d8d-442e-a44b-f99ce5f9e1af",
			);
			expect(trigger.reason).toBe("continue-button");
		});
	});

	describe("triggerFromManualAction", () => {
		it("creates a manual trigger", () => {
			const before = Date.now();
			const trigger = ContinueEngine.triggerFromManualAction();
			const after = Date.now();

			expect(trigger.source).toBe("manual");
			expect(trigger.reason).toBeUndefined();
			expect(trigger.sessionId).toBeUndefined();
			expect(trigger.timestamp).toBeGreaterThanOrEqual(before);
			expect(trigger.timestamp).toBeLessThanOrEqual(after);
			expect(trigger.detail).toContain("Manual");
		});

		it("does not include a sessionId (manual triggers bypass session check)", () => {
			const trigger = ContinueEngine.triggerFromManualAction();

			expect(trigger.sessionId).toBeUndefined();
		});
	});
});

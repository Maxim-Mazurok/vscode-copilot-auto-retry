import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Guardrails } from "./guardrails";
import { Logger } from "./logger";

vi.mock("./configuration", () => ({
	readConfig: vi.fn().mockReturnValue({
		enabled: true,
		continueMessage: "Keep going until the task is fully complete.",
		maxContinues: 3,
		baseDelayMs: 2000,
		maxDelayMs: 30_000,
		verboseLogging: false,
	}),
}));

import { readConfig } from "./configuration";

const mockedReadConfig = vi.mocked(readConfig);

function baseConfig() {
	return {
		enabled: true,
		continueMessage: "Keep going until the task is fully complete.",
		maxContinues: 3,
		baseDelayMs: 2000,
		maxDelayMs: 30_000,
		verboseLogging: false,
	};
}

function createGuardrails(): Guardrails {
	return new Guardrails(new Logger());
}

describe("Guardrails", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedReadConfig.mockReturnValue(baseConfig());
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("canContinue", () => {
		it("returns true when enabled and under the rate cap", () => {
			const guardrails = createGuardrails();
			expect(guardrails.canContinue()).toBe(true);
		});

		it("returns false when the extension is disabled", () => {
			mockedReadConfig.mockReturnValue({ ...baseConfig(), enabled: false });
			const guardrails = createGuardrails();
			expect(guardrails.canContinue()).toBe(false);
		});

		it("does not block repeatedly (no cooldown, no min-interval)", () => {
			const guardrails = createGuardrails();
			// Several back-to-back attempts remain allowed (indefinite continuation).
			for (let i = 0; i < 10; i++) {
				expect(guardrails.canContinue()).toBe(true);
				guardrails.recordContinueAttempt();
			}
		});

		it("engages loop protection after 30 continues in a minute, then clears", () => {
			const guardrails = createGuardrails();
			for (let i = 0; i < 30; i++) {
				guardrails.recordContinueAttempt();
			}
			expect(guardrails.canContinue()).toBe(false);

			// After the rolling window passes, it clears automatically.
			vi.advanceTimersByTime(61_000);
			expect(guardrails.canContinue()).toBe(true);
		});
	});

	describe("calculateDelay", () => {
		it("returns the base delay with light jitter (±15%)", () => {
			const guardrails = createGuardrails();

			vi.spyOn(Math, "random").mockReturnValue(0);
			expect(guardrails.calculateDelay()).toBe(1700); // 2000 * 0.85

			vi.spyOn(Math, "random").mockReturnValue(1);
			expect(guardrails.calculateDelay()).toBe(2300); // 2000 * 1.15
		});
	});

	describe("reset", () => {
		it("clears the rate-limit window", () => {
			const guardrails = createGuardrails();
			for (let i = 0; i < 30; i++) {
				guardrails.recordContinueAttempt();
			}
			expect(guardrails.canContinue()).toBe(false);

			guardrails.reset();
			expect(guardrails.canContinue()).toBe(true);
		});
	});
});

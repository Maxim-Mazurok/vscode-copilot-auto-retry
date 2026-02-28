import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Guardrails } from "./guardrails";
import { Logger } from "./logger";

/**
 * Mock the configuration module to control readConfig return values.
 */
vi.mock("./configuration", () => ({
	readConfig: vi.fn().mockReturnValue({
		enabled: true,
		maxRetries: 3,
		baseDelayMs: 2000,
		maxDelayMs: 30_000,
	}),
}));

import { readConfig } from "./configuration";

const mockedReadConfig = vi.mocked(readConfig);

function createGuardrails(): Guardrails {
	const logger = new Logger();
	return new Guardrails(logger);
}

/* ═══════════════════════════════ Tests ═══════════════════════════════════ */

describe("Guardrails", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedReadConfig.mockReturnValue({
			enabled: true,
			maxRetries: 3,
			baseDelayMs: 2000,
			maxDelayMs: 30_000,
		});
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("canRetry", () => {
		it("returns true when all guards pass", () => {
			const guardrails = createGuardrails();

			expect(guardrails.canRetry()).toBe(true);
		});

		it("returns false when extension is disabled", () => {
			mockedReadConfig.mockReturnValue({
				enabled: false,
				maxRetries: 3,
				baseDelayMs: 2000,
				maxDelayMs: 30_000,
			});

			const guardrails = createGuardrails();

			expect(guardrails.canRetry()).toBe(false);
		});

		it("returns false during cooldown after exhausted cycle", () => {
			const guardrails = createGuardrails();

			guardrails.recordCycleExhausted();

			expect(guardrails.canRetry()).toBe(false);
		});

		it("returns true after cooldown period expires (60s)", () => {
			const guardrails = createGuardrails();

			guardrails.recordCycleExhausted();
			expect(guardrails.canRetry()).toBe(false);

			// Advance past the 60-second cooldown
			vi.advanceTimersByTime(61_000);

			expect(guardrails.canRetry()).toBe(true);
		});

		it("returns false when absolute rate limit is reached (15 retries/minute)", () => {
			const guardrails = createGuardrails();

			// Record 15 retries, each spaced > 1s apart to satisfy minimum interval
			for (let i = 0; i < 15; i++) {
				guardrails.recordRetryAttempt();
				vi.advanceTimersByTime(1100);
			}

			expect(guardrails.canRetry()).toBe(false);
		});

		it("returns false when minimum interval (1s) has not elapsed", () => {
			const guardrails = createGuardrails();

			guardrails.recordRetryAttempt();
			// Don't advance time — still within 1s minimum interval

			expect(guardrails.canRetry()).toBe(false);
		});

		it("returns true after minimum interval elapses", () => {
			const guardrails = createGuardrails();

			guardrails.recordRetryAttempt();
			vi.advanceTimersByTime(1100);

			expect(guardrails.canRetry()).toBe(true);
		});

		it("prunes old entries from the sliding window after 60 seconds", () => {
			const guardrails = createGuardrails();

			// Record 14 retries — just under limit
			for (let i = 0; i < 14; i++) {
				guardrails.recordRetryAttempt();
				vi.advanceTimersByTime(1100);
			}
			expect(guardrails.canRetry()).toBe(true);

			// One more brings us to 15 — now blocked
			guardrails.recordRetryAttempt();
			vi.advanceTimersByTime(1100);
			expect(guardrails.canRetry()).toBe(false);

			// Advance past 60 seconds so the oldest entries fall off the window
			vi.advanceTimersByTime(60_000);
			expect(guardrails.canRetry()).toBe(true);
		});
	});

	describe("calculateDelay", () => {
		it("returns baseDelayMs * 0.8 for attempt 1 with minimum jitter", () => {
			const guardrails = createGuardrails();

			// Math.random() = 0 → jitter factor = 0.8 (minimum)
			vi.spyOn(Math, "random").mockReturnValue(0);

			const delay = guardrails.calculateDelay(1);

			// base * 2^0 * 0.8 = 2000 * 1 * 0.8 = 1600
			expect(delay).toBe(1600);
		});

		it("doubles delay for each subsequent attempt (at fixed jitter)", () => {
			const guardrails = createGuardrails();

			// Math.random() = 0.5 → jitter factor = 1.0 (neutral)
			vi.spyOn(Math, "random").mockReturnValue(0.5);

			const delayAttempt1 = guardrails.calculateDelay(1);
			const delayAttempt2 = guardrails.calculateDelay(2);
			const delayAttempt3 = guardrails.calculateDelay(3);

			expect(delayAttempt1).toBe(2000); // 2000 * 1 * 1.0
			expect(delayAttempt2).toBe(4000); // 2000 * 2 * 1.0
			expect(delayAttempt3).toBe(8000); // 2000 * 4 * 1.0
		});

		it("clamps delay at maxDelayMs", () => {
			const guardrails = createGuardrails();

			// At jitter factor 1.0
			vi.spyOn(Math, "random").mockReturnValue(0.5);

			// Attempt 5: 2000 * 2^4 = 32000, clamped to 30000
			const delay = guardrails.calculateDelay(5);

			expect(delay).toBe(30_000);
		});

		it("enforces minimum delay of 1000ms even with very low base", () => {
			mockedReadConfig.mockReturnValue({
				enabled: true,
				maxRetries: 3,
				baseDelayMs: 100,
				maxDelayMs: 30_000,
			});

			const guardrails = createGuardrails();

			// Minimum jitter: 100 * 1 * 0.8 = 80, floored to 1000
			vi.spyOn(Math, "random").mockReturnValue(0);

			const delay = guardrails.calculateDelay(1);

			expect(delay).toBe(1000);
		});

		it("adds jitter within ±20% range", () => {
			const guardrails = createGuardrails();

			// Minimum jitter (random=0 → factor=0.8)
			vi.spyOn(Math, "random").mockReturnValue(0);
			const minimumDelay = guardrails.calculateDelay(1);

			// Maximum jitter (random=1 → factor=1.2)
			vi.spyOn(Math, "random").mockReturnValue(1);
			const maximumDelay = guardrails.calculateDelay(1);

			// base=2000, attempt 1: exponential = 2000
			// min: 2000 * 0.8 = 1600
			// max: 2000 * 1.2 = 2400
			expect(minimumDelay).toBe(1600);
			expect(maximumDelay).toBe(2400);
		});
	});

	describe("recordCycleExhausted", () => {
		it("increments consecutive failure counter", () => {
			const guardrails = createGuardrails();

			expect(guardrails.getConsecutiveFailures()).toBe(0);

			guardrails.recordCycleExhausted();
			expect(guardrails.getConsecutiveFailures()).toBe(1);

			// Need to advance past cooldown before next cycle can be recorded
			vi.advanceTimersByTime(61_000);
			guardrails.recordCycleExhausted();
			expect(guardrails.getConsecutiveFailures()).toBe(2);
		});
	});

	describe("recordSuccess", () => {
		it("resets consecutive failure counter", () => {
			const guardrails = createGuardrails();

			guardrails.recordCycleExhausted();
			vi.advanceTimersByTime(61_000);
			guardrails.recordCycleExhausted();
			expect(guardrails.getConsecutiveFailures()).toBe(2);

			guardrails.recordSuccess();

			expect(guardrails.getConsecutiveFailures()).toBe(0);
		});
	});

	describe("reset", () => {
		it("clears all state (cooldown, rate limiter, consecutive failures)", () => {
			const guardrails = createGuardrails();

			// Build up some state
			guardrails.recordRetryAttempt();
			guardrails.recordCycleExhausted();
			expect(guardrails.canRetry()).toBe(false); // In cooldown
			expect(guardrails.getConsecutiveFailures()).toBe(1);

			guardrails.reset();

			expect(guardrails.canRetry()).toBe(true);
			expect(guardrails.getConsecutiveFailures()).toBe(0);
		});
	});
});

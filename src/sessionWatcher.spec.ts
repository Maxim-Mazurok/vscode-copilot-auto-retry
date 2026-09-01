import { describe, expect, it } from "vitest";
import {
	type ErrorDetails,
	type JsonlEntry,
	NON_CONTINUABLE_CODES,
	hasContinueButton,
	parseSessionContent,
	processJsonlEntry,
} from "./sessionWatcher";

/* ═══════════════════════════ Real result fixtures ═════════════════════════ */

/**
 * Real network error from a production session file. Carries a continue button,
 * so it is a continue opportunity.
 */
const NETWORK_ERROR_ENTRY: JsonlEntry = {
	kind: 1,
	k: ["requests", 0, "result"],
	v: {
		errorDetails: {
			code: "networkError",
			message:
				"Sorry, there was a network error. Please try again later. Request id: 315afeba-0332-4523-beab-cf31dd1923d2",
			confirmationButtons: [
				{ data: { copilotContinueOnError: true }, label: "Try Again" },
			],
			responseIsIncomplete: true,
		},
	},
};

/**
 * Real rate-limit error from a production session file. Carries a continue
 * button, so it is a continue opportunity.
 */
const RATE_LIMIT_ERROR_ENTRY: JsonlEntry = {
	kind: 1,
	k: ["requests", 18, "result"],
	v: {
		errorDetails: {
			code: "rateLimited",
			message:
				"Sorry, you have exhausted this model's rate limit. Please wait a moment before trying again, or switch to GPT-4.1.",
			level: 0,
			isRateLimited: true,
			confirmationButtons: [
				{ data: { copilotContinueOnError: true }, label: "Try Again" },
			],
			responseIsIncomplete: true,
		},
	},
};

/**
 * User cancellation. Has a continue button but must NEVER be auto-continued.
 */
const CANCELED_ERROR_ENTRY: JsonlEntry = {
	kind: 1,
	k: ["requests", 5, "result"],
	v: {
		errorDetails: {
			code: "canceled",
			message: "Canceled",
			confirmationButtons: [
				{ data: { copilotContinueOnError: true }, label: "Try Again" },
			],
			responseIsIncomplete: true,
		},
	},
};

/** A successful request result (no errorDetails) — a clean turn-ended pause. */
const SUCCESSFUL_RESULT_ENTRY: JsonlEntry = {
	kind: 1,
	k: ["requests", 0, "result"],
	v: {
		metadata: { finishReason: "stop" },
	},
};

/* ═══════════════════════ Helper: JSONL line builder ══════════════════════ */

function toJsonlContent(...entries: JsonlEntry[]): string {
	return entries.map((entry) => JSON.stringify(entry)).join("\n");
}

/* ═══════════════════════════════ Tests ═══════════════════════════════════ */

describe("hasContinueButton", () => {
	it("returns true for network error with copilotContinueOnError button", () => {
		const errorDetails: ErrorDetails = NETWORK_ERROR_ENTRY.v.errorDetails;
		expect(hasContinueButton(errorDetails)).toBe(true);
	});

	it("returns true for rate-limit error with copilotContinueOnError button", () => {
		const errorDetails: ErrorDetails = RATE_LIMIT_ERROR_ENTRY.v.errorDetails;
		expect(hasContinueButton(errorDetails)).toBe(true);
	});

	it("returns false when confirmationButtons is missing", () => {
		const errorDetails: ErrorDetails = {
			code: "networkError",
			message: "some error",
		};
		expect(hasContinueButton(errorDetails)).toBe(false);
	});

	it("returns false when confirmationButtons is an empty array", () => {
		const errorDetails: ErrorDetails = {
			code: "networkError",
			message: "some error",
			confirmationButtons: [],
		};
		expect(hasContinueButton(errorDetails)).toBe(false);
	});

	it("returns false when button data does not have copilotContinueOnError", () => {
		const errorDetails: ErrorDetails = {
			code: "networkError",
			message: "some error",
			confirmationButtons: [{ data: {}, label: "OK" }],
		};
		expect(hasContinueButton(errorDetails)).toBe(false);
	});

	it("returns false when copilotContinueOnError is explicitly false", () => {
		const errorDetails: ErrorDetails = {
			code: "networkError",
			message: "some error",
			confirmationButtons: [
				{ data: { copilotContinueOnError: false }, label: "Dismiss" },
			],
		};
		expect(hasContinueButton(errorDetails)).toBe(false);
	});
});

describe("processJsonlEntry", () => {
	describe("kind 0 — full snapshot", () => {
		it("finds result in a snapshot request", () => {
			const entry: JsonlEntry = {
				kind: 0,
				v: {
					requests: [
						{ result: { errorDetails: { code: "networkError" } } },
					],
				},
			};

			const results: Array<{
				requestIndex: number;
				errorDetails: ErrorDetails | undefined;
			}> = [];
			processJsonlEntry(entry, (requestIndex, errorDetails) => {
				results.push({ requestIndex, errorDetails });
			});

			expect(results).toHaveLength(1);
			expect(results[0].requestIndex).toBe(0);
			expect(results[0].errorDetails?.code).toBe("networkError");
		});

		it("finds multiple request results in a snapshot", () => {
			const entry: JsonlEntry = {
				kind: 0,
				v: {
					requests: [
						{ result: { metadata: { finishReason: "stop" } } },
						{ result: { errorDetails: { code: "rateLimited" } } },
					],
				},
			};

			const results: Array<{
				requestIndex: number;
				errorDetails: ErrorDetails | undefined;
			}> = [];
			processJsonlEntry(entry, (requestIndex, errorDetails) => {
				results.push({ requestIndex, errorDetails });
			});

			expect(results).toHaveLength(2);
			expect(results[0].errorDetails).toBeUndefined();
			expect(results[1].errorDetails?.code).toBe("rateLimited");
		});

		it("skips requests without a result property", () => {
			const entry: JsonlEntry = {
				kind: 0,
				v: { requests: [{ message: "hello" }, { message: "world" }] },
			};

			const results: Array<{ requestIndex: number }> = [];
			processJsonlEntry(entry, (requestIndex) => {
				results.push({ requestIndex });
			});

			expect(results).toHaveLength(0);
		});

		it("handles missing requests property", () => {
			const entry: JsonlEntry = { kind: 0, v: { title: "some chat" } };

			const results: Array<{ requestIndex: number }> = [];
			processJsonlEntry(entry, (requestIndex) => {
				results.push({ requestIndex });
			});

			expect(results).toHaveLength(0);
		});
	});

	describe("kind 1 — key-path patch", () => {
		it("extracts result from a production result entry", () => {
			const results: Array<{
				requestIndex: number;
				errorDetails: ErrorDetails | undefined;
			}> = [];
			processJsonlEntry(NETWORK_ERROR_ENTRY, (requestIndex, errorDetails) => {
				results.push({ requestIndex, errorDetails });
			});

			expect(results).toHaveLength(1);
			expect(results[0].requestIndex).toBe(0);
			expect(results[0].errorDetails?.code).toBe("networkError");
		});

		it("extracts a successful result (no errorDetails)", () => {
			const results: Array<{
				requestIndex: number;
				errorDetails: ErrorDetails | undefined;
			}> = [];
			processJsonlEntry(SUCCESSFUL_RESULT_ENTRY, (requestIndex, errorDetails) => {
				results.push({ requestIndex, errorDetails });
			});

			expect(results).toHaveLength(1);
			expect(results[0].errorDetails).toBeUndefined();
		});

		it("ignores patches that do not target request results", () => {
			const entry: JsonlEntry = {
				kind: 1,
				k: ["requests", 0, "response"],
				v: { some: "data" },
			};

			const results: Array<{ requestIndex: number }> = [];
			processJsonlEntry(entry, (requestIndex) => {
				results.push({ requestIndex });
			});

			expect(results).toHaveLength(0);
		});
	});

	describe("kind 2 — key replacement", () => {
		it("finds results when the requests array is fully replaced", () => {
			const entry: JsonlEntry = {
				kind: 2,
				k: ["requests"],
				v: [
					{ result: { metadata: { finishReason: "stop" } } },
					{ result: { errorDetails: { code: "networkError" } } },
				],
			};

			const results: Array<{
				requestIndex: number;
				errorDetails: ErrorDetails | undefined;
			}> = [];
			processJsonlEntry(entry, (requestIndex, errorDetails) => {
				results.push({ requestIndex, errorDetails });
			});

			expect(results).toHaveLength(2);
			expect(results[1].errorDetails?.code).toBe("networkError");
		});
	});
});

describe("parseSessionContent — pause detection", () => {
	it("reports a turn-ended pause for a clean successful result", () => {
		const content = toJsonlContent(SUCCESSFUL_RESULT_ENTRY);
		const result = parseSessionContent(content);

		expect(result.latestPause).toBeDefined();
		expect(result.latestPause!.reason).toBe("turn-ended");
		expect(result.latestPause!.code).toBe("ok");
		expect(result.latestPause!.requestIndex).toBe(0);
	});

	it("reports a continue-button pause for a network error", () => {
		const content = toJsonlContent(NETWORK_ERROR_ENTRY);
		const result = parseSessionContent(content);

		expect(result.latestPause).toBeDefined();
		expect(result.latestPause!.reason).toBe("continue-button");
		expect(result.latestPause!.code).toBe("networkError");
	});

	it("reports a continue-button pause for a rate limit", () => {
		const content = toJsonlContent(RATE_LIMIT_ERROR_ENTRY);
		const result = parseSessionContent(content);

		expect(result.latestPause).toBeDefined();
		expect(result.latestPause!.reason).toBe("continue-button");
		expect(result.latestPause!.code).toBe("rateLimited");
		expect(result.latestPause!.requestIndex).toBe(18);
	});

	it("never reports a pause for a user cancellation", () => {
		const content = toJsonlContent(CANCELED_ERROR_ENTRY);
		const result = parseSessionContent(content);

		expect(result.latestPause).toBeUndefined();
	});

	it("does not report a pause for an error without a continue button", () => {
		const entry: JsonlEntry = {
			kind: 1,
			k: ["requests", 0, "result"],
			v: { errorDetails: { code: "internalError", message: "broke" } },
		};

		const result = parseSessionContent(toJsonlContent(entry));
		expect(result.latestPause).toBeUndefined();
		expect(result.highestResultRequestIndex).toBe(0);
	});

	it("uses the highest request index to determine latest state", () => {
		// Error on request 0, then a clean turn-ended result on request 5.
		const successOnFive: JsonlEntry = {
			kind: 1,
			k: ["requests", 5, "result"],
			v: { metadata: { finishReason: "stop" } },
		};
		const content = toJsonlContent(NETWORK_ERROR_ENTRY, successOnFive);
		const result = parseSessionContent(content);

		expect(result.latestPause).toBeDefined();
		expect(result.latestPause!.reason).toBe("turn-ended");
		expect(result.highestResultRequestIndex).toBe(5);
	});

	it("switches to continue-button when a newer request errors", () => {
		const content = toJsonlContent(SUCCESSFUL_RESULT_ENTRY, RATE_LIMIT_ERROR_ENTRY);
		const result = parseSessionContent(content);

		expect(result.latestPause).toBeDefined();
		expect(result.latestPause!.reason).toBe("continue-button");
		expect(result.latestPause!.requestIndex).toBe(18);
	});

	it("switches to no-pause when a newer request is canceled", () => {
		const content = toJsonlContent(NETWORK_ERROR_ENTRY, CANCELED_ERROR_ENTRY);
		const result = parseSessionContent(content);

		expect(result.latestPause).toBeUndefined();
		expect(result.highestResultRequestIndex).toBe(5);
	});

	describe("final-state reconstruction", () => {
		it("reconstructs the end state across snapshot, replacement, and patch", () => {
			// kind 0 base with one in-flight request, then kind 2 replaces the
			// whole array with two requests, then kind 1 patches request 1's
			// result to a completed turn.
			const snapshot: JsonlEntry = {
				kind: 0,
				v: { requests: [{ message: { text: "first" } }] },
			};
			const replacement: JsonlEntry = {
				kind: 2,
				k: ["requests"],
				v: [
					{ result: { metadata: {} } },
					{ message: { text: "second, in flight" } },
				],
			};
			const patch: JsonlEntry = {
				kind: 1,
				k: ["requests", 1, "result"],
				v: { metadata: {}, responseTimestamp: Date.now() },
			};

			const content = toJsonlContent(snapshot, replacement, patch);
			const result = parseSessionContent(content);

			expect(result.latestPause).toBeDefined();
			expect(result.latestPause!.reason).toBe("turn-ended");
			expect(result.latestPause!.requestIndex).toBe(1);
		});

		it("treats a later kind:2 replacement as authoritative over earlier state", () => {
			const errored: JsonlEntry = {
				kind: 2,
				k: ["requests"],
				v: [{ result: { errorDetails: { code: "failed" } } }],
			};
			const cleared: JsonlEntry = {
				kind: 2,
				k: ["requests"],
				v: [{ message: { text: "restarted, in flight" } }],
			};

			const content = toJsonlContent(errored, cleared);
			const result = parseSessionContent(content);

			// The final array's last request has no result → no pause.
			expect(result.latestPause).toBeUndefined();
		});

		it("extracts finishedAt from responseTimestamp", () => {
			const ts = 1_788_245_000_000;
			const entry: JsonlEntry = {
				kind: 2,
				k: ["requests"],
				v: [{ result: { metadata: {} }, responseTimestamp: ts }],
			};

			const result = parseSessionContent(toJsonlContent(entry));
			expect(result.latestPause!.finishedAt).toBe(ts);
		});

		it("extracts finishedAt from the last tool-call round timestamp", () => {
			const ts = 1_788_245_111_222;
			const entry: JsonlEntry = {
				kind: 2,
				k: ["requests"],
				v: [
					{
						result: {
							metadata: { toolCallRounds: [{ timestamp: ts }] },
						},
					},
				],
			};

			const result = parseSessionContent(toJsonlContent(entry));
			expect(result.latestPause!.finishedAt).toBe(ts);
		});

		it("does not continue a clean result flagged isCanceled", () => {
			const entry: JsonlEntry = {
				kind: 2,
				k: ["requests"],
				v: [{ result: { metadata: {} }, isCanceled: true }],
			};

			const result = parseSessionContent(toJsonlContent(entry));
			expect(result.latestPause).toBeUndefined();
		});

		it("distinguishes consecutive turns that reuse requests[0] (in-place replace)", () => {
			// VS Code stores empty-window conversations as a single requests[0]
			// that is replaced via kind:2 each turn. Two completed turns share
			// index 0 / reason / code, so finishedAt must differ to be a new pause.
			const turn1: JsonlEntry = {
				kind: 2,
				k: ["requests"],
				v: [{ result: { metadata: {} }, responseTimestamp: 1_788_246_000_000 }],
			};
			const turn2: JsonlEntry = {
				kind: 2,
				k: ["requests"],
				v: [{ result: { metadata: {} }, responseTimestamp: 1_788_246_343_065 }],
			};

			const p1 = parseSessionContent(toJsonlContent(turn1)).latestPause;
			const p2 = parseSessionContent(toJsonlContent(turn2)).latestPause;

			expect(p1!.requestIndex).toBe(p2!.requestIndex);
			expect(p1!.reason).toBe(p2!.reason);
			expect(p1!.finishedAt).not.toBe(p2!.finishedAt);
		});

		it("detects a real code:'failed' continue button (production shape)", () => {
			const entry: JsonlEntry = {
				kind: 2,
				k: ["requests"],
				v: [
					{
						responseTimestamp: Date.now(),
						result: {
							errorDetails: {
								code: "failed",
								message: "Sorry, your request failed. Please try again.",
								confirmationButtons: [
									{
										data: { copilotContinueOnError: true },
										label: "Try Again",
									},
								],
								responseIsIncomplete: true,
							},
						},
					},
				],
			};

			const result = parseSessionContent(toJsonlContent(entry));
			expect(result.latestPause).toBeDefined();
			expect(result.latestPause!.reason).toBe("continue-button");
			expect(result.latestPause!.code).toBe("failed");
		});
	});

	describe("edge cases", () => {
		it("returns no pause for empty content", () => {
			const result = parseSessionContent("");
			expect(result.latestPause).toBeUndefined();
			expect(result.highestResultRequestIndex).toBe(-1);
		});

		it("returns no pause for whitespace-only content", () => {
			const result = parseSessionContent("   \n\n   \n");
			expect(result.latestPause).toBeUndefined();
		});

		it("skips malformed JSON lines gracefully", () => {
			const content = [
				"this is not json",
				JSON.stringify(NETWORK_ERROR_ENTRY),
				"{ broken json {{{",
			].join("\n");

			const result = parseSessionContent(content);
			expect(result.latestPause).toBeDefined();
			expect(result.latestPause!.code).toBe("networkError");
		});
	});
});

describe("NON_CONTINUABLE_CODES", () => {
	it("contains 'canceled'", () => {
		expect(NON_CONTINUABLE_CODES.has("canceled")).toBe(true);
	});

	it("does not contain 'networkError'", () => {
		expect(NON_CONTINUABLE_CODES.has("networkError")).toBe(false);
	});

	it("does not contain 'rateLimited'", () => {
		expect(NON_CONTINUABLE_CODES.has("rateLimited")).toBe(false);
	});
});

/* ══════════════════════ Regression: large result entries ══════════════════ */

describe("parseSessionContent — large result entry regression", () => {
	/** Build a large result entry that mimics a real-world ~69 KB payload. */
	function buildLargeRateLimitResultEntry(paddingBytes: number): JsonlEntry {
		const padding = "x".repeat(paddingBytes);
		return {
			kind: 1,
			k: ["requests", 0, "result"],
			v: {
				errorDetails: {
					code: "rateLimited",
					message: "Sorry, you have exhausted this model's rate limit.",
					level: 0,
					isRateLimited: true,
					confirmationButtons: [
						{ data: { copilotContinueOnError: true }, label: "Try Again" },
					],
					responseIsIncomplete: true,
				},
				metadata: { toolCallRounds: [{ content: padding }] },
			},
		};
	}

	it("detects a pause from full content even when the result entry is very large", () => {
		const snapshot: JsonlEntry = {
			kind: 0,
			v: { requests: [{ message: { text: "do something" } }] },
		};
		const largeResult = buildLargeRateLimitResultEntry(60_000);
		const followups: JsonlEntry = {
			kind: 1,
			k: ["requests", 0, "followups"],
			v: [],
		};
		const modelState: JsonlEntry = {
			kind: 1,
			k: ["requests", 0, "modelState"],
			v: { isStale: false },
		};

		const fullContent = toJsonlContent(
			snapshot,
			largeResult,
			followups,
			modelState,
		);
		const result = parseSessionContent(fullContent);

		expect(result.latestPause).toBeDefined();
		expect(result.latestPause!.reason).toBe("continue-button");
		expect(result.latestPause!.code).toBe("rateLimited");
		expect(result.highestResultRequestIndex).toBe(0);
	});

	it("reports no result entries when content has only non-result lines", () => {
		const followups: JsonlEntry = {
			kind: 1,
			k: ["requests", 0, "followups"],
			v: [],
		};
		const modelState: JsonlEntry = {
			kind: 1,
			k: ["requests", 0, "modelState"],
			v: { isStale: false },
		};
		const response: JsonlEntry = {
			kind: 2,
			k: ["requests", 0, "response"],
			v: { text: "some response text" },
		};

		const tailOnlyContent = toJsonlContent(followups, modelState, response);
		const result = parseSessionContent(tailOnlyContent);

		expect(result.latestPause).toBeUndefined();
		expect(result.highestResultRequestIndex).toBe(-1);
	});
});

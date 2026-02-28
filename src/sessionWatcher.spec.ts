import { describe, expect, it } from "vitest";
import {
	type ErrorDetails,
	type JsonlEntry,
	NON_RETRYABLE_ERROR_CODES,
	type ParsedSessionResult,
	hasRetryButton,
	parseSessionContent,
	processJsonlEntry,
} from "./sessionWatcher";

/* ═══════════════════════════ Real error fixtures ══════════════════════════ */

/**
 * Real network error from a production session file.
 * Source: session f729284b-c3a0-439e-b39b-7e2c55f1696c.jsonl
 * Trigger: user asked "update readme with emojis", network dropped mid-request.
 */
const NETWORK_ERROR_ENTRY: JsonlEntry = {
	kind: 1,
	k: ["requests", 0, "result"],
	v: {
		errorDetails: {
			code: "networkError",
			message:
				"Sorry, there was a network error. Please try again later. Request id: 315afeba-0332-4523-beab-cf31dd1923d2\n\nReason: Please check your firewall rules and network connection then try again. Error Code: net::ERR_NETWORK_CHANGED: [object Object].",
			confirmationButtons: [
				{ data: { copilotContinueOnError: true }, label: "Try Again" },
			],
			responseIsIncomplete: true,
		},
	},
};

/**
 * Real rate-limit error from a production session file.
 * Source: session 82e4b7e4-4d8d-442e-a44b-f99ce5f9e1af.jsonl (line 261)
 * Trigger: user asked "I think that we should migrate the caretaker.sh",
 * hit the model rate limit after many requests.
 */
const RATE_LIMIT_ERROR_ENTRY: JsonlEntry = {
	kind: 1,
	k: ["requests", 18, "result"],
	v: {
		errorDetails: {
			code: "rateLimited",
			message:
				"Sorry, you have exhausted this model's rate limit. Please wait a moment before trying again, or switch to GPT-4.1. [Learn More](https://aka.ms/github-copilot-rate-limit-error)",
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
 * Synthetic user-cancellation error (observed shape from session files).
 * Has a "Try Again" button but should NOT be auto-retried.
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

/** A successful request result (no errorDetails). */
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

describe("hasRetryButton", () => {
	it("returns true for network error with copilotContinueOnError button", () => {
		const errorDetails: ErrorDetails = NETWORK_ERROR_ENTRY.v.errorDetails;
		expect(hasRetryButton(errorDetails)).toBe(true);
	});

	it("returns true for rate-limit error with copilotContinueOnError button", () => {
		const errorDetails: ErrorDetails = RATE_LIMIT_ERROR_ENTRY.v.errorDetails;
		expect(hasRetryButton(errorDetails)).toBe(true);
	});

	it("returns true for canceled error (button exists even though we skip it later)", () => {
		const errorDetails: ErrorDetails = CANCELED_ERROR_ENTRY.v.errorDetails;
		expect(hasRetryButton(errorDetails)).toBe(true);
	});

	it("returns false when confirmationButtons is missing", () => {
		const errorDetails: ErrorDetails = {
			code: "networkError",
			message: "some error",
		};
		expect(hasRetryButton(errorDetails)).toBe(false);
	});

	it("returns false when confirmationButtons is an empty array", () => {
		const errorDetails: ErrorDetails = {
			code: "networkError",
			message: "some error",
			confirmationButtons: [],
		};
		expect(hasRetryButton(errorDetails)).toBe(false);
	});

	it("returns false when button data does not have copilotContinueOnError", () => {
		const errorDetails: ErrorDetails = {
			code: "networkError",
			message: "some error",
			confirmationButtons: [{ data: {}, label: "OK" }],
		};
		expect(hasRetryButton(errorDetails)).toBe(false);
	});

	it("returns false when copilotContinueOnError is explicitly false", () => {
		const errorDetails: ErrorDetails = {
			code: "networkError",
			message: "some error",
			confirmationButtons: [
				{ data: { copilotContinueOnError: false }, label: "Dismiss" },
			],
		};
		expect(hasRetryButton(errorDetails)).toBe(false);
	});
});

describe("processJsonlEntry", () => {
	describe("kind 0 — full snapshot", () => {
		it("finds error in a snapshot request result", () => {
			const entry: JsonlEntry = {
				kind: 0,
				v: {
					requests: [
						{
							result: {
								errorDetails: {
									code: "networkError",
									message: "Network failed",
									confirmationButtons: [
										{ data: { copilotContinueOnError: true }, label: "Try Again" },
									],
								},
							},
						},
					],
				},
			};

			const results: Array<{ requestIndex: number; errorDetails: ErrorDetails | undefined }> = [];
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
						{
							result: {
								errorDetails: {
									code: "rateLimited",
									message: "Rate limited",
									isRateLimited: true,
									level: 0,
									confirmationButtons: [
										{ data: { copilotContinueOnError: true }, label: "Try Again" },
									],
								},
							},
						},
					],
				},
			};

			const results: Array<{ requestIndex: number; errorDetails: ErrorDetails | undefined }> = [];
			processJsonlEntry(entry, (requestIndex, errorDetails) => {
				results.push({ requestIndex, errorDetails });
			});

			expect(results).toHaveLength(2);
			expect(results[0].requestIndex).toBe(0);
			expect(results[0].errorDetails).toBeUndefined();
			expect(results[1].requestIndex).toBe(1);
			expect(results[1].errorDetails?.code).toBe("rateLimited");
		});

		it("skips requests without a result property", () => {
			const entry: JsonlEntry = {
				kind: 0,
				v: {
					requests: [{ message: "hello" }, { message: "world" }],
				},
			};

			const results: Array<{ requestIndex: number }> = [];
			processJsonlEntry(entry, (requestIndex) => {
				results.push({ requestIndex });
			});

			expect(results).toHaveLength(0);
		});

		it("handles empty requests array", () => {
			const entry: JsonlEntry = { kind: 0, v: { requests: [] } };

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
		it("extracts network error from real production entry", () => {
			const results: Array<{ requestIndex: number; errorDetails: ErrorDetails | undefined }> = [];
			processJsonlEntry(NETWORK_ERROR_ENTRY, (requestIndex, errorDetails) => {
				results.push({ requestIndex, errorDetails });
			});

			expect(results).toHaveLength(1);
			expect(results[0].requestIndex).toBe(0);
			expect(results[0].errorDetails?.code).toBe("networkError");
			expect(results[0].errorDetails?.confirmationButtons).toHaveLength(1);
			expect(results[0].errorDetails?.confirmationButtons?.[0].data?.copilotContinueOnError).toBe(true);
		});

		it("extracts rate-limit error from real production entry", () => {
			const results: Array<{ requestIndex: number; errorDetails: ErrorDetails | undefined }> = [];
			processJsonlEntry(RATE_LIMIT_ERROR_ENTRY, (requestIndex, errorDetails) => {
				results.push({ requestIndex, errorDetails });
			});

			expect(results).toHaveLength(1);
			expect(results[0].requestIndex).toBe(18);
			expect(results[0].errorDetails?.code).toBe("rateLimited");
			expect(results[0].errorDetails?.isRateLimited).toBe(true);
			expect(results[0].errorDetails?.level).toBe(0);
		});

		it("extracts canceled error", () => {
			const results: Array<{ requestIndex: number; errorDetails: ErrorDetails | undefined }> = [];
			processJsonlEntry(CANCELED_ERROR_ENTRY, (requestIndex, errorDetails) => {
				results.push({ requestIndex, errorDetails });
			});

			expect(results).toHaveLength(1);
			expect(results[0].requestIndex).toBe(5);
			expect(results[0].errorDetails?.code).toBe("canceled");
		});

		it("extracts successful result (no errorDetails)", () => {
			const results: Array<{ requestIndex: number; errorDetails: ErrorDetails | undefined }> = [];
			processJsonlEntry(SUCCESSFUL_RESULT_ENTRY, (requestIndex, errorDetails) => {
				results.push({ requestIndex, errorDetails });
			});

			expect(results).toHaveLength(1);
			expect(results[0].requestIndex).toBe(0);
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

		it("ignores patches with too few key-path segments", () => {
			const entry: JsonlEntry = {
				kind: 1,
				k: ["requests"],
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
		it("finds errors when requests array is replaced", () => {
			const entry: JsonlEntry = {
				kind: 2,
				k: ["requests"],
				v: [
					{ result: { metadata: { finishReason: "stop" } } },
					{
						result: {
							errorDetails: {
								code: "networkError",
								message: "Replaced request with error",
								confirmationButtons: [
									{ data: { copilotContinueOnError: true }, label: "Try Again" },
								],
							},
						},
					},
				],
			};

			const results: Array<{ requestIndex: number; errorDetails: ErrorDetails | undefined }> = [];
			processJsonlEntry(entry, (requestIndex, errorDetails) => {
				results.push({ requestIndex, errorDetails });
			});

			expect(results).toHaveLength(2);
			expect(results[0].errorDetails).toBeUndefined();
			expect(results[1].errorDetails?.code).toBe("networkError");
		});

		it("ignores kind 2 entries with non-requests key", () => {
			const entry: JsonlEntry = {
				kind: 2,
				k: ["title"],
				v: "New chat title",
			};

			const results: Array<{ requestIndex: number }> = [];
			processJsonlEntry(entry, (requestIndex) => {
				results.push({ requestIndex });
			});

			expect(results).toHaveLength(0);
		});
	});

	describe("unknown kinds", () => {
		it("ignores entries with unrecognized kind", () => {
			const entry: JsonlEntry = { kind: 99, v: { requests: [{ result: {} }] } };

			const results: Array<{ requestIndex: number }> = [];
			processJsonlEntry(entry, (requestIndex) => {
				results.push({ requestIndex });
			});

			expect(results).toHaveLength(0);
		});
	});
});

describe("parseSessionContent", () => {
	describe("network error detection", () => {
		it("detects a retryable network error from a single JSONL line", () => {
			const content = toJsonlContent(NETWORK_ERROR_ENTRY);
			const result = parseSessionContent(content);

			expect(result.latestError).toBeDefined();
			expect(result.latestError!.code).toBe("networkError");
			expect(result.latestError!.hasRetryButton).toBe(true);
			expect(result.latestError!.requestIndex).toBe(0);
			expect(result.latestError!.message).toContain("network error");
		});

		it("includes the full error message for network errors", () => {
			const content = toJsonlContent(NETWORK_ERROR_ENTRY);
			const result = parseSessionContent(content);

			expect(result.latestError!.message).toContain("ERR_NETWORK_CHANGED");
			expect(result.latestError!.message).toContain("315afeba");
		});
	});

	describe("rate-limit error detection", () => {
		it("detects a retryable rate-limit error from a single JSONL line", () => {
			const content = toJsonlContent(RATE_LIMIT_ERROR_ENTRY);
			const result = parseSessionContent(content);

			expect(result.latestError).toBeDefined();
			expect(result.latestError!.code).toBe("rateLimited");
			expect(result.latestError!.hasRetryButton).toBe(true);
			expect(result.latestError!.requestIndex).toBe(18);
		});

		it("includes the rate-limit suggestion to switch models", () => {
			const content = toJsonlContent(RATE_LIMIT_ERROR_ENTRY);
			const result = parseSessionContent(content);

			expect(result.latestError!.message).toContain("exhausted this model's rate limit");
			expect(result.latestError!.message).toContain("GPT-4.1");
		});
	});

	describe("user cancellation (non-retryable)", () => {
		it("detects canceled error (NON_RETRYABLE_ERROR_CODES includes 'canceled')", () => {
			expect(NON_RETRYABLE_ERROR_CODES.has("canceled")).toBe(true);
		});

		it("reports canceled error with hasRetryButton true (filtering is caller's job)", () => {
			const content = toJsonlContent(CANCELED_ERROR_ENTRY);
			const result = parseSessionContent(content);

			expect(result.latestError).toBeDefined();
			expect(result.latestError!.code).toBe("canceled");
			// hasRetryButton is true because the button exists in the JSONL —
			// the SessionWatcher class checks NON_RETRYABLE_ERROR_CODES to skip it
			expect(result.latestError!.hasRetryButton).toBe(true);
		});
	});

	describe("recovery detection", () => {
		it("clears error when the latest request for the same index succeeds", () => {
			// First: error on request 0
			// Then: success on request 0
			const content = toJsonlContent(NETWORK_ERROR_ENTRY, SUCCESSFUL_RESULT_ENTRY);
			const result = parseSessionContent(content);

			expect(result.latestError).toBeUndefined();
			expect(result.highestResultRequestIndex).toBe(0);
		});

		it("keeps error when a newer request index has an error", () => {
			// Success on request 0, then error on request 18
			const content = toJsonlContent(SUCCESSFUL_RESULT_ENTRY, RATE_LIMIT_ERROR_ENTRY);
			const result = parseSessionContent(content);

			expect(result.latestError).toBeDefined();
			expect(result.latestError!.code).toBe("rateLimited");
			expect(result.latestError!.requestIndex).toBe(18);
		});

		it("clears error when a success at higher-or-equal index follows", () => {
			const successAtIndex18: JsonlEntry = {
				kind: 1,
				k: ["requests", 18, "result"],
				v: { metadata: { finishReason: "stop" } },
			};
			const content = toJsonlContent(RATE_LIMIT_ERROR_ENTRY, successAtIndex18);
			const result = parseSessionContent(content);

			expect(result.latestError).toBeUndefined();
			expect(result.highestResultRequestIndex).toBe(18);
		});
	});

	describe("multi-line JSONL content", () => {
		it("handles multiple requests across many JSONL lines", () => {
			// Simulate a realistic session: snapshot, then a few patches
			const snapshot: JsonlEntry = {
				kind: 0,
				v: {
					requests: [{ result: { metadata: { finishReason: "stop" } } }],
				},
			};
			const secondRequestSuccess: JsonlEntry = {
				kind: 1,
				k: ["requests", 1, "result"],
				v: { metadata: { finishReason: "stop" } },
			};
			const thirdRequestError: JsonlEntry = {
				kind: 1,
				k: ["requests", 2, "result"],
				v: {
					errorDetails: {
						code: "networkError",
						message: "Connection lost",
						confirmationButtons: [
							{ data: { copilotContinueOnError: true }, label: "Try Again" },
						],
					},
				},
			};

			const content = toJsonlContent(snapshot, secondRequestSuccess, thirdRequestError);
			const result = parseSessionContent(content);

			expect(result.latestError).toBeDefined();
			expect(result.latestError!.code).toBe("networkError");
			expect(result.latestError!.requestIndex).toBe(2);
			expect(result.highestResultRequestIndex).toBe(2);
		});

		it("uses the highest request index to determine the latest state", () => {
			// Error on request 0, success on request 5
			const errorOnZero = NETWORK_ERROR_ENTRY;
			const successOnFive: JsonlEntry = {
				kind: 1,
				k: ["requests", 5, "result"],
				v: { metadata: { finishReason: "stop" } },
			};

			const content = toJsonlContent(errorOnZero, successOnFive);
			const result = parseSessionContent(content);

			// Request 5 > request 0, so the latest state is success
			expect(result.latestError).toBeUndefined();
			expect(result.highestResultRequestIndex).toBe(5);
		});
	});

	describe("kind 0 snapshot parsing", () => {
		it("detects error from initial snapshot", () => {
			const snapshot: JsonlEntry = {
				kind: 0,
				v: {
					requests: [
						{
							result: {
								errorDetails: {
									code: "rateLimited",
									message: "Rate limited on startup",
									isRateLimited: true,
									level: 0,
									confirmationButtons: [
										{ data: { copilotContinueOnError: true }, label: "Try Again" },
									],
								},
							},
						},
					],
				},
			};

			const content = toJsonlContent(snapshot);
			const result = parseSessionContent(content);

			expect(result.latestError).toBeDefined();
			expect(result.latestError!.code).toBe("rateLimited");
			expect(result.latestError!.requestIndex).toBe(0);
		});
	});

	describe("kind 2 replacement parsing", () => {
		it("detects error when requests array is fully replaced", () => {
			const replacement: JsonlEntry = {
				kind: 2,
				k: ["requests"],
				v: [
					{ result: { metadata: { finishReason: "stop" } } },
					{
						result: {
							errorDetails: {
								code: "networkError",
								message: "Error after replacement",
								confirmationButtons: [
									{ data: { copilotContinueOnError: true }, label: "Try Again" },
								],
							},
						},
					},
				],
			};

			const content = toJsonlContent(replacement);
			const result = parseSessionContent(content);

			expect(result.latestError).toBeDefined();
			expect(result.latestError!.code).toBe("networkError");
			expect(result.latestError!.requestIndex).toBe(1);
		});
	});

	describe("edge cases", () => {
		it("returns no error for empty content", () => {
			const result = parseSessionContent("");
			expect(result.latestError).toBeUndefined();
			expect(result.highestResultRequestIndex).toBe(-1);
		});

		it("returns no error for whitespace-only content", () => {
			const result = parseSessionContent("   \n\n   \n");
			expect(result.latestError).toBeUndefined();
		});

		it("skips malformed JSON lines gracefully", () => {
			const content = [
				"this is not json",
				JSON.stringify(NETWORK_ERROR_ENTRY),
				"{ broken json {{{",
			].join("\n");

			const result = parseSessionContent(content);
			expect(result.latestError).toBeDefined();
			expect(result.latestError!.code).toBe("networkError");
		});

		it("handles error without confirmationButtons (no retry button)", () => {
			const entry: JsonlEntry = {
				kind: 1,
				k: ["requests", 0, "result"],
				v: {
					errorDetails: {
						code: "internalError",
						message: "Something broke internally",
					},
				},
			};

			const content = toJsonlContent(entry);
			const result = parseSessionContent(content);

			expect(result.latestError).toBeDefined();
			expect(result.latestError!.code).toBe("internalError");
			expect(result.latestError!.hasRetryButton).toBe(false);
		});

		it("handles error with missing code (defaults to 'unknown')", () => {
			const entry: JsonlEntry = {
				kind: 1,
				k: ["requests", 0, "result"],
				v: {
					errorDetails: {
						message: "Mystery error",
						confirmationButtons: [
							{ data: { copilotContinueOnError: true }, label: "Try Again" },
						],
					},
				},
			};

			const content = toJsonlContent(entry);
			const result = parseSessionContent(content);

			expect(result.latestError).toBeDefined();
			expect(result.latestError!.code).toBe("unknown");
			expect(result.latestError!.hasRetryButton).toBe(true);
		});

		it("handles error with missing message (defaults to empty string)", () => {
			const entry: JsonlEntry = {
				kind: 1,
				k: ["requests", 0, "result"],
				v: {
					errorDetails: {
						code: "networkError",
					},
				},
			};

			const content = toJsonlContent(entry);
			const result = parseSessionContent(content);

			expect(result.latestError).toBeDefined();
			expect(result.latestError!.message).toBe("");
		});
	});
});

describe("NON_RETRYABLE_ERROR_CODES", () => {
	it("contains 'canceled'", () => {
		expect(NON_RETRYABLE_ERROR_CODES.has("canceled")).toBe(true);
	});

	it("does not contain 'networkError' (should be retryable)", () => {
		expect(NON_RETRYABLE_ERROR_CODES.has("networkError")).toBe(false);
	});

	it("does not contain 'rateLimited' (should be retryable)", () => {
		expect(NON_RETRYABLE_ERROR_CODES.has("rateLimited")).toBe(false);
	});
});

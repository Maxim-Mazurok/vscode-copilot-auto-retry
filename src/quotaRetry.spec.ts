import { describe, expect, it } from "vitest";
import { isDailyQuotaError, parseQuotaResetDelay } from "./quotaRetry";

describe("daily quota detection", () => {
  it.each([
    ["quotaExceeded", "Daily credit limit exceeded. Quota resets in 4 hours."],
    ["rateLimited", "You have exhausted your daily quota."],
    ["dailyLimitExceeded", "Please try again later."],
  ])("recognizes %s: %s", (code, message) => {
    expect(isDailyQuotaError(code, message)).toBe(true);
  });

  it.each([
    ["rateLimited", "You have exhausted this model's rate limit."],
    ["quotaExceeded", "Monthly credit limit exceeded."],
    ["networkError", "Network unavailable."],
  ])("keeps %s on the normal path: %s", (code, message) => {
    expect(isDailyQuotaError(code, message)).toBe(false);
  });
});

describe("quota reset duration", () => {
  it.each([
    ["Quota resets in 2 hours and 30 minutes.", 9_000_000],
    ["quota resets in 2h 30m", 9_000_000],
    ["Quota resets in 1 day, 2 hrs, 3 mins and 4 secs.", 93_784_000],
    ["Resets in 1.5 hours", 5_400_000],
    ["Quota resets in 45 minutes.", 2_700_000],
    ["Your quota will reset in 3 hours.", 10_800_000],
  ])("parses %s", (message, duration) => {
    expect(parseQuotaResetDelay(message)).toBe(duration + 1000);
  });

  it.each([
    "Daily quota exceeded", "Quota resets tomorrow", "Quota resets in 0 hours",
    "Quota resets in -2h", "Quota resets in 999999999 hours",
    "Quota resets in 1 month", "Quota resets on October 24",
    "Quota resets in 2h:30m", "Quota resets in 2 hours 30 unknown units",
  ])("falls back for %s", (message) => {
    expect(parseQuotaResetDelay(message)).toBeUndefined();
  });
});

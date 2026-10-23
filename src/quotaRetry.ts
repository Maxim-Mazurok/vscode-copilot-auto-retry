/** Daily quota failures can be retried even when Copilot omits Try Again. */
export function isDailyQuotaError(code: string, message: string): boolean {
  return /daily.*(?:quota|credit|limit)|(?:quota|credit|limit).*daily/i.test(
    `${code} ${message}`,
  );
}

/**
 * Parse relative reset durations such as "quota resets in 2h 30m".
 * Unsupported/localized formats fall back to the configured delay.
 */
export function parseQuotaResetDelay(message: string): number | undefined {
  const reset = /(?:quota\s+)?(?:will\s+)?resets?\s+in\s+((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/i.exec(message);
  if (!reset) {
    return undefined;
  }
  // Do not accept only the first part of an unsupported duration.
  if (/^\s*[:\d-]/.test(message.slice(reset.index + reset[0].length))) {
    return undefined;
  }

  let milliseconds = 0;
  for (const part of reset[1].matchAll(/(\d+(?:\.\d+)?)\s*(d\w*|h\w*|m\w*|s\w*)/gi)) {
    const unit = part[2][0].toLowerCase();
    const multiplier = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 }[unit]!;
    milliseconds += Number(part[1]) * multiplier;
  }

  // Keep the timeout within Node's supported range, with a one-second margin.
  return milliseconds > 0 && milliseconds < 2_147_482_647
    ? Math.ceil(milliseconds) + 1000
    : undefined;
}

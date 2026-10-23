import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { readConfig } from "./configuration";
import { Guardrails } from "./guardrails";
import { Logger } from "./logger";
import { RetryEngine } from "./retryEngine";
import { SessionWatcher, type SessionError } from "./sessionWatcher";
import { ActiveSessionResolver } from "./activeSessionResolver";

vi.mock("./configuration", () => ({ readConfig: vi.fn() }));

const HOURS = 3_600_000;
const quotaError = (message = "Daily credit limit exceeded"): SessionError => ({
  sessionId: "quota-session", errorCode: "quotaExceeded", message,
  hasRetryButton: false, detectedAt: Date.now(),
});

describe("daily quota retry lifecycle", () => {
  let engine: RetryEngine;
  let watcher: SessionWatcher;
  let resolver: ActiveSessionResolver;
  let guardrails: Guardrails;
  let commands: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
    vi.mocked(readConfig).mockReturnValue({
      enabled: true, maxRetries: 3, baseDelayMs: 2000, maxDelayMs: 30000,
      dailyQuotaRetryDelayHours: 6,
    });
    const logger = new Logger();
    resolver = new ActiveSessionResolver(logger);
    vi.spyOn(resolver, "isSessionActive").mockResolvedValue(true);
    commands = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);
    guardrails = new Guardrails(logger);
    engine = new RetryEngine(logger, guardrails, resolver);
    watcher = new SessionWatcher(logger);
    watcher.onRetryableError(error => {
      void engine.triggerRetryCycle(RetryEngine.triggerFromSessionError(error));
    });
    watcher.onRecovery(sessionId => engine.cancelActiveCycle("recovered", sessionId));
  });

  afterEach(() => {
    engine.dispose();
    watcher.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("detects a buttonless quota error and waits six hours before submitting once", async () => {
    const error = quotaError();
    watcher["processSessionContent"](error.sessionId, JSON.stringify({
      kind: 1, k: ["requests", 0, "result"],
      v: { errorDetails: { code: error.errorCode, message: error.message } },
    }));
    expect(engine.getState()).toBe("waiting");
    expect(engine.getNextRetryAt()).toBe(Date.now() + 6 * HOURS);
    await vi.advanceTimersByTimeAsync(6 * HOURS - 1);
    expect(commands).not.toHaveBeenCalled();
    // A network event during the wait must not shorten it.
    await engine.triggerRetryCycle(RetryEngine.triggerFromNetworkRecovery());
    await vi.advanceTimersByTimeAsync(401);
    expect(resolver.isSessionActive).toHaveBeenCalledWith(error.sessionId);
    expect(commands).toHaveBeenCalledWith("workbench.action.chat.submit", expect.any(Object));
    expect(commands).toHaveBeenCalledTimes(2);
    expect(engine.getState()).toBe("idle");
  });

  it("uses the full reset message even beyond the logged detail truncation", async () => {
    const error = quotaError("Daily quota exceeded. " + "x".repeat(150) + " Quota resets in 10h 30m.");
    const trigger = RetryEngine.triggerFromSessionError(error);
    expect(trigger.retryNotBefore).toBe(Date.now() + 10.5 * HOURS + 1000);
    await engine.triggerRetryCycle(trigger);
    await vi.advanceTimersByTimeAsync(10.5 * HOURS);
    expect(commands).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1400);
    expect(commands).toHaveBeenCalledWith("workbench.action.chat.submit", expect.any(Object));
  });

  it("honors a custom fallback for an unsupported reset format", async () => {
    vi.mocked(readConfig).mockReturnValue({ ...readConfig(), dailyQuotaRetryDelayHours: 12 });
    await engine.triggerRetryCycle(RetryEngine.triggerFromSessionError(quotaError("Daily quota exceeded. Resets tomorrow.")));
    expect(engine.getNextRetryAt()).toBe(Date.now() + 12 * HOURS);
  });

  it.each(["recent attempt", "exhausted cycle"])("queues the quota wait despite a %s", async (restriction) => {
    if (restriction === "recent attempt") {
      guardrails.recordRetryAttempt();
    } else {
      guardrails.recordCycleExhausted();
    }
    await engine.triggerRetryCycle(RetryEngine.triggerFromSessionError(quotaError("Daily quota exceeded. Resets in 8 hours.")));
    expect(engine.getNextRetryAt()).toBe(Date.now() + 8 * HOURS + 1000);
    await vi.advanceTimersByTimeAsync(8 * HOURS + 1400);
    expect(commands).toHaveBeenCalledWith("workbench.action.chat.submit", expect.any(Object));
  });

  it("cancels the pending wait on disposal", async () => {
    await engine.triggerRetryCycle(RetryEngine.triggerFromSessionError(quotaError()));
    engine.dispose();
    await vi.advanceTimersByTimeAsync(24 * HOURS);
    expect(commands).not.toHaveBeenCalled();
  });

  it("cancels a quota wait when the user stops the request", async () => {
    const result = (code: string, message: string) => JSON.stringify({
      kind: 1, k: ["requests", 0, "result"], v: { errorDetails: { code, message } },
    });
    watcher["processSessionContent"]("quota-session", result("quotaExceeded", "Daily quota exceeded"));
    expect(engine.getState()).toBe("waiting");
    watcher["processSessionContent"]("quota-session", result("canceled", "Canceled"));
    await vi.advanceTimersByTimeAsync(24 * HOURS);
    expect(commands).not.toHaveBeenCalled();
    expect(watcher.hasActiveErrors()).toBe(false);
    expect(engine.getState()).toBe("idle");
  });

  it.each([
    ["canceled", "Daily credit limit exceeded"],
    ["quotaExceeded", "Monthly quota exceeded"],
  ])("does not schedule buttonless %s: %s", (code, message) => {
    watcher["processSessionContent"]("ignored-session", JSON.stringify({
      kind: 1, k: ["requests", 0, "result"], v: { errorDetails: { code, message } },
    }));
    expect(engine.getState()).toBe("idle");
    expect(engine.getNextRetryAt()).toBeUndefined();
  });

  it("only cancels for recovery of the same session", async () => {
    await engine.triggerRetryCycle(RetryEngine.triggerFromSessionError(quotaError()));
    engine.cancelActiveCycle("unrelated recovery", "other-session");
    expect(engine.getState()).toBe("waiting");
    engine.cancelActiveCycle("quota session recovered", "quota-session");
    await vi.advanceTimersByTimeAsync(24 * HOURS);
    expect(commands).not.toHaveBeenCalled();
  });

  it.each(["network", "manual"])("cancels an unscoped %s cycle when a session recovers", async (source) => {
    const trigger = source === "network"
      ? RetryEngine.triggerFromNetworkRecovery()
      : RetryEngine.triggerFromManualAction();
    await engine.triggerRetryCycle(trigger);
    engine.cancelActiveCycle("session recovered", "quota-session");
    await vi.advanceTimersByTimeAsync(30000);
    expect(commands).not.toHaveBeenCalled();
    expect(engine.getState()).toBe("idle");
  });

  it("does not submit into another active session after the wait", async () => {
    vi.mocked(resolver.isSessionActive).mockResolvedValue(false);
    await engine.triggerRetryCycle(RetryEngine.triggerFromSessionError(quotaError()));
    await vi.advanceTimersByTimeAsync(6 * HOURS + 1000);
    expect(commands).not.toHaveBeenCalled();
    expect(engine.getState()).toBe("idle");
  });

  it("still checks the enabled guardrail when the wait expires", async () => {
    await engine.triggerRetryCycle(RetryEngine.triggerFromSessionError(quotaError()));
    vi.mocked(readConfig).mockReturnValue({ ...readConfig(), enabled: false });
    await vi.advanceTimersByTimeAsync(6 * HOURS + 1000);
    expect(commands).not.toHaveBeenCalled();
  });

  it("keeps ordinary model rate limits on the short backoff", async () => {
    await engine.triggerRetryCycle(RetryEngine.triggerFromSessionError({
      ...quotaError(), errorCode: "rateLimited", message: "Model rate limit exhausted", hasRetryButton: true,
    }));
    expect(engine.getNextRetryAt()! - Date.now()).toBeLessThan(30000);
    await vi.advanceTimersByTimeAsync(30000);
    expect(commands).toHaveBeenCalledWith("workbench.action.chat.submit", expect.any(Object));
  });
});

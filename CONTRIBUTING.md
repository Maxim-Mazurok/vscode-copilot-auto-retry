# Contributing to Copilot Auto-Retry

Thank you for your interest in contributing! This document covers the architecture, design decisions, and development workflow.

## Architecture Overview

```
ErrorDetector ──> RetryEngine ──> chat.submit (focus + send prompt)
     ^                |
     |                v
HealthMonitor     Guardrails
     |                |
     +────────────────+
          StatusBar (read-only view)
```

### Component Responsibilities

| Component | File | Purpose |
|---|---|---|
| **ErrorDetector** | `src/errorDetector.ts` | Detects transient Copilot failures via multiple signals: extension activation state, language model availability, LM accessibility probe, `vscode.lm.onDidChangeChatModels` events, and diagnostic changes |
| **RetryEngine** | `src/retryEngine.ts` | Manages retry cycles with exponential backoff. Executes retries by focusing the chat panel and submitting a follow-up prompt |
| **Guardrails** | `src/guardrails.ts` | Safety layer that prevents runaway retry loops. Enforces rate limits (15 retries/minute), minimum intervals (1 second), and cooldown periods (60 seconds after exhaustion) |
| **HealthMonitor** | `src/healthMonitor.ts` | Periodic poller that runs health checks at configurable intervals. Feeds detected errors to the retry engine and cancels active cycles when health recovers |
| **NetworkMonitor** | `src/networkMonitor.ts` | Monitors network connectivity by probing GitHub/Copilot endpoints. Detects offline-to-online transitions and triggers retries on recovery |
| **StatusBar** | `src/statusBar.ts` | Read-only status bar item showing the current engine state (idle, waiting, retrying, cooldown, disabled) |
| **Logger** | `src/logger.ts` | Structured logging to a dedicated "Copilot Auto-Retry" output channel |
| **Configuration** | `src/configuration.ts` | Live-reading configuration wrapper over VS Code settings |

### Data Flow

1. **Detection**: `ErrorDetector` identifies a transient failure (rate limit, network error, model unavailability)
2. **Event emission**: The error is emitted to registered listeners
3. **Guardrail check**: `RetryEngine` consults `Guardrails` to verify a retry is permitted
4. **Backoff scheduling**: A timer is set using exponential backoff with jitter
5. **Execution**: The retry is executed by focusing the chat panel and submitting a follow-up prompt
6. **Outcome**: On success, the cycle ends. On failure, the next attempt is scheduled until `maxRetries` is exhausted

## Key Design Decision: Why "Chat Submit" Instead of the "Try Again" Button

This is the most important architectural decision in the extension and deserves detailed explanation.

### The Problem

When a Copilot Chat request fails with a transient error (rate limit, network disruption, etc.), VS Code shows a "Try Again" button in the chat UI. Ideally, we would programmatically click that button. However, **no VS Code API exists to do this**.

### Three Potential Approaches (Investigated)

#### 1. `workbench.action.chat.retry` Command

VS Code has a built-in `workbench.action.chat.retry` command, but it requires an **internal response-view-model object** as its first argument. This object is part of the chat widget's internal state and is not exposed to third-party extensions. When called without arguments (or with incorrect ones), the command silently no-ops.

**Verdict**: Unusable from a third-party extension.

#### 2. Programmatically Trigger the "Try Again" Confirmation Button

The "Try Again" button is implemented via VS Code's proposed `chatParticipantPrivate` API. Here is how it works internally:

1. When an error occurs, the Copilot Chat extension's `modifyErrorDetails()` method attaches `confirmationButtons` to the error details:
   ```typescript
   errorDetails.confirmationButtons = [
       { data: { copilotContinueOnError: true }, label: 'Try Again' },
   ];
   ```
2. VS Code renders this as a clickable button in the chat UI.
3. When the user clicks it, VS Code creates a **new `ChatRequest`** with `acceptedConfirmationData` containing the button's data payload.
4. The Copilot Chat extension detects this via `isContinueOnError(request)` and sets `isContinuation = true`, which tells the prompt system to replay the previous request context seamlessly.

The critical issue: the click is handled entirely within VS Code's internal chat widget renderer. There is **no command, API, or event** that a third-party extension can use to trigger a confirmation button click. The `confirmationButtons` property itself is part of a *proposed* (non-stable) API available only to first-party extensions.

**Verdict**: Not possible from a third-party extension.

#### 3. Focus Chat Panel + Submit Follow-Up Message (Chosen Approach)

The `workbench.action.chat.submit` command accepts an `{ inputValue: string }` parameter and submits a message in the currently focused chat widget. Combined with `workbench.panel.chat.view.copilot.focus` to ensure the chat panel is active, this provides a reliable way to trigger a retry.

**Trade-offs**:
- Sends a new turn in the conversation (costs one extra message)
- The AI sees the failed request and error in history, plus our retry prompt
- Preserves full conversation context
- Works reliably from any third-party extension
- Does not depend on proposed or internal APIs

**Verdict**: Only viable approach. This is what the extension uses.

### Why Not Build This Into Copilot Chat Itself?

If auto-retry were built directly into the Copilot Chat extension (rather than as a separate third-party extension), it could use the internal `isContinuation` flow or invoke the retry through the internal request handler. This would be cleaner, avoid the extra message overhead, and have access to the actual error state. However, this extension exists as an independent, user-installable solution that works without modifying Copilot Chat.

## Error Detection Strategy

The extension uses **passive observation only** and never intercepts or wraps Copilot's request pipeline. Detection signals:

| Signal | How It Works | What It Catches |
|---|---|---|
| Extension activation state | Checks `vscode.extensions.getExtension()` | Copilot extension crashes or deactivation |
| Language model availability | Calls `vscode.lm.selectChatModels()` | Models disappearing (service outage) |
| LM accessibility probe | Sends a minimal `sendRequest()` and cancels immediately | Rate limits (error thrown before tokens generated, costs zero quota) |
| `onDidChangeChatModels` event | Reactive listener on `vscode.lm` | Model list changes in real-time |
| Diagnostic changes | Listens to `vscode.languages.onDidChangeDiagnostics` | Copilot-sourced transient error diagnostics |
| Network probing | HTTP HEAD requests to GitHub/Copilot endpoints | Network outages and recovery |

### Error Classification

Errors are classified into three categories using regex pattern matching:

- **Retryable**: Rate limits, timeouts, network errors, service unavailable (429, 502, 503, etc.)
- **Non-retryable**: Authentication failures, expired tokens, subscription issues (require user action)
- **Ambiguous**: Unknown errors (silently ignored to avoid false positives)

## Safety Guardrails

The `Guardrails` class enforces multiple safety constraints:

| Guardrail | Value | Purpose |
|---|---|---|
| Absolute rate limit | 15 retries per 60-second sliding window | Prevents runaway retry loops |
| Minimum interval | 1,000 ms between any two attempts | Prevents rapid-fire retries |
| Cycle cooldown | 60,000 ms after exhausting all attempts | Prevents immediate re-triggering |
| Extension enabled check | Must be enabled in settings | User kill switch |

Backoff calculation uses exponential delay with jitter: `base * 2^(attempt-1) * jitter(0.8..1.2)`, clamped to `maxDelayMs`.

## Development Setup

### Prerequisites

- Node.js 18+
- VS Code 1.90+

### Build

```bash
cd vscode-copilot-auto-retry
npm install
npm run compile
```

### Watch Mode

```bash
npm run watch
```

### Package as VSIX

```bash
npm run package
```

This produces a `.vsix` file you can install locally via `code --install-extension <file>.vsix`.

### Testing Locally

1. Open the extension folder in VS Code
2. Press `F5` to launch the Extension Development Host
3. Use the command palette commands:
   - **Copilot Auto-Retry: Show Status** to verify the extension is running
   - **Copilot Auto-Retry: [Dev] Simulate Rate-Limit Error** to test the full retry pipeline end-to-end

### Project Structure

```
src/
  extension.ts        Entry point, wiring, command registration
  errorDetector.ts    Passive error detection via multiple signals
  retryEngine.ts      Retry cycle management with exponential backoff
  guardrails.ts       Safety constraints and rate limiting
  healthMonitor.ts    Periodic health polling
  networkMonitor.ts   Network connectivity monitoring
  statusBar.ts        Status bar UI
  logger.ts           Output channel logging
  configuration.ts    Settings wrapper
```

## Code Conventions

- TypeScript strict mode
- No default exports
- Descriptive variable names (no abbreviations)
- All retry attempts must pass through `Guardrails.canRetry()` before execution
- All disposable resources must be registered in `context.subscriptions`
- Error detection must be passive (no interception of Copilot's request pipeline)

## Future Considerations

- If VS Code exposes an API to programmatically trigger confirmation buttons or retry failed chat responses, the retry mechanism should be updated to use that instead of the "chat submit" approach
- The `chatParticipantPrivate` proposed API may eventually become stable and accessible to third-party extensions
- The `workbench.action.chat.retry` command may eventually accept no arguments and retry the last failed response

# Contributing to Copilot Auto-Retry

Thank you for your interest in contributing! This document covers the architecture, the real-world challenges we encountered building this extension, and development setup.

## Architecture Overview

```
SessionWatcher ─── (error detected) ──> RetryEngine ──> chat.submit (focus + submit prompt)
     ^                                       |
     | (watches JSONL files)                 v
     |                                   Guardrails
     |                                       |
     +-- ActiveSessionResolver               |
     |   (reads state.vscdb via sqlite3)     |
     |                                       |
NetworkMonitor ── (recovery event) ──────────+
     |   (gated by sessionWatcher.hasActiveErrors())
     |
     +───────── StatusBar (read-only view)
```

### Component Responsibilities

| Component | File | Purpose |
|---|---|---|
| **SessionWatcher** | `src/sessionWatcher.ts` | Watches chat session JSONL files on disk for error entries. Detects `errorDetails` in request results and fires events when a retryable error is found or when an error recovers. |
| **ActiveSessionResolver** | `src/activeSessionResolver.ts` | Reads `state.vscdb` (SQLite) to determine which chat session is currently active. Used as a safety gate before retrying — if the user switched sessions, the retry is skipped. |
| **RetryEngine** | `src/retryEngine.ts` | Manages retry cycles with exponential backoff. Executes retries by focusing the chat panel and submitting a follow-up prompt. Checks active session before each attempt. |
| **Guardrails** | `src/guardrails.ts` | Safety layer that prevents runaway retry loops. Enforces rate limits (15 retries/minute), minimum intervals (1 second), and cooldown periods (60 seconds after exhaustion). |
| **NetworkMonitor** | `src/networkMonitor.ts` | Monitors network connectivity by probing GitHub/Copilot endpoints. Detects offline-to-online transitions and triggers retries — but only if the SessionWatcher has active errors in this window. |
| **StatusBar** | `src/statusBar.ts` | Read-only status bar item showing the current engine state (idle, waiting, retrying, cooldown, disabled). |
| **Logger** | `src/logger.ts` | Structured logging to a dedicated "Copilot Auto-Retry" output channel. |
| **Configuration** | `src/configuration.ts` | Live-reading configuration wrapper over VS Code settings. |

### Data Flow

1. **Detection**: SessionWatcher detects an error entry in a chat session JSONL file (e.g., `code: "networkError"` or `code: "rateLimited"` with a `copilotContinueOnError` confirmation button).
2. **Filtering**: Non-retryable errors (`canceled`) and errors without a "Try Again" button are ignored.
3. **Trigger creation**: A `RetryTrigger` is created with the session ID, error code, and details.
4. **Guardrail check**: RetryEngine consults Guardrails to verify a retry is permitted.
5. **Backoff scheduling**: A timer is set using exponential backoff with jitter.
6. **Active session check**: Before each attempt, the engine reads `state.vscdb` via sqlite3 to verify the errored session is still the active one.
7. **Execution**: The retry focuses the chat panel and submits a follow-up prompt via `workbench.action.chat.submit`.
8. **Recovery**: The SessionWatcher detects when an error is resolved (a successful result appears for the same or higher request index) and cancels any active retry cycle.

## Challenges and How We Overcame Them

### Challenge 1: No Public API for Chat Error State

**Problem**: VS Code has no public extension API to detect whether a Copilot chat conversation is in an error state. The `ChatResponseTurn.result.errorDetails` property is only available inside a chat participant's response handler — not to third-party observers. The "Try Again" button is implemented via a proposed (`chatParticipantPrivate`) API that only first-party extensions can use.

**Approaches investigated**:

1. **Language Model API probe** (v0.1.0–v0.2.4): Send a minimal `sendRequest()` to the LM and cancel immediately to detect rate limits. This worked for some errors but was unreliable — it couldn't detect errors in specific conversations, only service-level issues. It also produced false positives at startup before models were initialized.

2. **DOM manipulation**: VS Code's chat panel is rendered in the native Electron renderer, not in a webview. Extensions cannot access the DOM.

3. **`workbench.action.chat.retry` command**: This command exists but requires an internal response-view-model object as its first argument. When called without arguments, it silently no-ops. The view model is not exposed to third-party extensions.

**Solution**: We discovered that VS Code Core writes chat sessions to disk as JSONL files at `workspaceStorage/<hash>/chatSessions/<sessionId>.jsonl`. These files contain the full conversation state including `errorDetails` on failed requests. The SessionWatcher monitors these files and parses them for error entries.

### Challenge 2: Understanding the JSONL Format

**Problem**: The JSONL session files use three kinds of entries that are not documented anywhere:

| Kind | Name | Meaning |
|---|---|---|
| `kind: 0` | Snapshot | Full conversation state — contains a `requests[]` array with all request/response pairs |
| `kind: 1` | Key-path patch | Updates a single nested property — key path like `["requests", 0, "result"]` with a value |
| `kind: 2` | Key replacement | Replaces an entire top-level key — e.g., replaces the entire `requests` array |

**Solution**: We reverse-engineered the format from real session files. Errors appear as `errorDetails` objects inside `requests[N].result`. Two real error shapes were found:

**Network error** (session `f729284b`):
```json
{"kind":1,"k":["requests",0,"result"],"v":{"errorDetails":{"code":"networkError","message":"Sorry, there was a network error...","confirmationButtons":[{"data":{"copilotContinueOnError":true},"label":"Try Again"}],"responseIsIncomplete":true}}}
```

**Rate limit** (session `82e4b7e4`, line 261):
```json
{"kind":1,"k":["requests",18,"result"],"v":{"errorDetails":{"code":"rateLimited","message":"Sorry, you have exhausted this model's rate limit...","level":0,"isRateLimited":true,"confirmationButtons":[{"data":{"copilotContinueOnError":true},"label":"Try Again"}],"responseIsIncomplete":true}}}
```

The key signal is the `confirmationButtons` array containing a button with `data.copilotContinueOnError: true` — this is the "Try Again" button.

### Challenge 3: No Way to Press "Try Again" Programmatically

**Problem**: The "Try Again" button is the ideal retry mechanism — it replays the exact failed request using `isContinuation` mode internally. But:

1. `workbench.action.chat.retry` requires an internal view-model object.
2. The `confirmationButtons` API is proposed-only (`chatParticipantPrivate`), restricted to first-party extensions.
3. There is no command or event to trigger a button click.

**Solution**: We use `workbench.action.chat.submit` with an `inputValue` parameter. This submits a new message in the current conversation asking the AI to retry. It adds one extra turn but preserves the full conversation context (the AI sees the error in history). This is the only approach that works from a third-party extension.

### Challenge 4: Multi-Window Isolation

**Problem**: When multiple VS Code windows are open, a network recovery in one window could trigger a retry in all windows (since the NetworkMonitor runs independently in each extension host).

**Solution**: The SessionWatcher already has per-window isolation — each window watches only its own `workspaceStorage/<hash>/chatSessions/` directory. We added a `hasActiveErrors()` gate on the network recovery handler: recovery only triggers a retry if the SessionWatcher in *this window* has detected an unresolved error.

### Challenge 5: Multi-Session Targeting

**Problem**: A single VS Code window can have multiple chat sessions. `workbench.action.chat.submit` always submits to the currently active (visible) chat widget. If the user switched sessions after an error occurred, the retry prompt would go to the wrong conversation.

**Solution**: We read the active session ID from `state.vscdb` — a SQLite database VS Code maintains at `workspaceStorage/<hash>/state.vscdb`. The key `memento/interactive-session-view-copilot` contains JSON with a `sessionId` field matching the JSONL filename. We query this via the `sqlite3` CLI (pre-installed on macOS and most Linux systems) before each retry attempt. If the active session doesn't match the errored session, the retry is skipped.

This degrades gracefully: if `sqlite3` is not available, the database is locked, or the key doesn't exist, we proceed with the retry (assume the correct session is active).

## Key Design Decision: Why "Chat Submit" Instead of "Try Again"

This is documented in detail in Challenge 3 above. In summary: there is no public API for a third-party extension to trigger VS Code's internal "Try Again" button. The `chat.submit` approach is the only viable method.

**Trade-offs**:
- Sends a new turn in the conversation (costs one extra message)
- The AI sees the failed request and error in history, plus our retry prompt
- Preserves full conversation context
- Works reliably from any third-party extension
- Does not depend on proposed or internal APIs

### Why Not Build This Into Copilot Chat Itself?

If auto-retry were built directly into the Copilot Chat extension, it could use the internal `isContinuation` flow or invoke the retry through the internal request handler. This would be cleaner, avoid the extra message overhead, and have access to the actual error state.

## Safety Guardrails

The `Guardrails` class enforces multiple safety constraints:

| Guardrail | Value | Purpose |
|---|---|---|
| Absolute rate limit | 15 retries per 60-second sliding window | Prevents runaway retry loops |
| Minimum interval | 1,000 ms between any two attempts | Prevents rapid-fire retries |
| Cycle cooldown | 60,000 ms after exhausting all attempts | Prevents immediate re-triggering |
| Extension enabled check | Must be enabled in settings | User kill switch |
| Active session check | Verifies errored session is still visible | Prevents retrying in wrong conversation |
| Network recovery gate | `sessionWatcher.hasActiveErrors()` | Prevents cross-window false positives |

Backoff calculation uses exponential delay with jitter: `base * 2^(attempt-1) * jitter(0.8..1.2)`, clamped to `maxDelayMs`.

## Known Limitations

1. **Session file format is undocumented** — The JSONL format (`kind: 0/1/2`) was reverse-engineered from real session files. VS Code could change this format without notice. The extension degrades gracefully if parsing fails (no crash, just no detection).

2. **Cannot target a specific chat session** — `workbench.action.chat.submit` always goes to the currently focused chat widget. There is no parameter to specify which session to submit to. The `ActiveSessionResolver` mitigates this by checking before retrying, but it's a safety gate, not a targeting mechanism.

3. **`sqlite3` dependency for active session check** — The `sqlite3` CLI is used to read from `state.vscdb`. It's pre-installed on macOS (always) and most Linux distributions. On Windows or minimal Linux containers, it may not be available. Without it, the active session check is skipped (graceful degradation).

4. **Retry adds a conversation turn** — Unlike the native "Try Again" button (which replays the exact request), our retry submits a new message. This costs one additional LM turn and slightly changes the conversation flow.

5. **Single retry cycle at a time** — If errors occur in multiple sessions simultaneously, only the first one triggers a retry. The rest are ignored until the active cycle completes or is cancelled.

6. **Cannot detect errors in collapsed/hidden sessions** — Session files are only updated while the session exists. If VS Code doesn't write the error to disk (edge case), we can't detect it.

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

### Run Tests

```bash
npm test
```

Tests use vitest. The `vscode` module is mocked (see `src/__mocks__/vscode.ts`) so tests run without the VS Code extension host.

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
  extension.ts                Entry point, wiring, command registration
  sessionWatcher.ts           Primary error detection via chat session JSONL files
  activeSessionResolver.ts    Active session verification via state.vscdb (sqlite3)
  retryEngine.ts              Retry cycle management with exponential backoff
  guardrails.ts               Safety constraints and rate limiting
  networkMonitor.ts           Network connectivity monitoring
  statusBar.ts                Status bar UI
  logger.ts                   Output channel logging
  configuration.ts            Settings wrapper
  sessionWatcher.spec.ts      Tests: JSONL parsing and error detection
  activeSessionResolver.spec.ts  Tests: sqlite3 integration and session matching
  guardrails.spec.ts          Tests: safety guardrail logic
  retryEngine.spec.ts         Tests: trigger factory methods
  __mocks__/
    vscode.ts                 Minimal vscode module mock for tests
```

## Code Conventions

- TypeScript strict mode
- No default exports
- Descriptive variable names (no abbreviations)
- All retry attempts must pass through `Guardrails.canRetry()` before execution
- All disposable resources must be registered in `context.subscriptions`
- Error detection must be passive (no interception of Copilot's request pipeline)
- Zero runtime npm dependencies — only `vscode` (provided by the host) and dev dependencies

## Future Considerations

- If VS Code exposes an API to programmatically trigger confirmation buttons or retry failed chat responses, the retry mechanism should be updated to use that instead of the "chat submit" approach
- The `chatParticipantPrivate` proposed API may eventually become stable and accessible to third-party extensions
- The `workbench.action.chat.retry` command may eventually accept no arguments and retry the last failed response
- If VS Code adds a public API for reading chat session state (error details, active session), the filesystem approach can be replaced

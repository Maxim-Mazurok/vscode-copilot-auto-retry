# Contributing to Copilot Long Run

Thank you for your interest in contributing! This document covers the architecture, the real-world challenges behind the extension, and development setup.

## Architecture Overview

```
SessionWatcher ─── (pause detected) ──> ContinueEngine ──> chat.submit (focus + submit prompt)
     ^                                        |
     | (watches JSONL files)                  v
     |                                    Guardrails
     |                                        |
     +-- ActiveSessionResolver                |
     |   (reads state.vscdb via sqlite3)      |
     |                                        |
     +───────── StatusBar (read-only view) ───+
```

### Component Responsibilities

| Component | File | Purpose |
|---|---|---|
| **SessionWatcher** | `src/sessionWatcher.ts` | Watches chat session JSONL files on disk. Classifies the latest request's result and fires a pause event when the agent's turn ended or a continue button appeared, and a resume event when a newer request is in flight. |
| **ActiveSessionResolver** | `src/activeSessionResolver.ts` | Reads `state.vscdb` (SQLite) to determine which chat session is currently active. Used as a safety gate before continuing — if the user switched sessions, the continue is skipped. |
| **ContinueEngine** | `src/continueEngine.ts` | Manages continue cycles with exponential backoff. Sends a continue message by focusing the chat panel and submitting a follow-up prompt. Checks the active session before each attempt. |
| **Guardrails** | `src/guardrails.ts` | Safety layer that prevents runaway continue loops. Enforces rate limits (15 continues/minute), minimum intervals (1 second), and cooldown periods (60 seconds after exhaustion). |
| **StatusBar** | `src/statusBar.ts` | Read-only status bar item showing the current engine state (idle, waiting, continuing, cooldown, disabled). |
| **Logger** | `src/logger.ts` | Structured logging to a dedicated "Copilot Long Run" output channel. |
| **Configuration** | `src/configuration.ts` | Live-reading configuration wrapper over VS Code settings. |

### Data Flow

1. **Detection**: SessionWatcher reads a chat session JSONL file and looks at the latest request's `result`.
2. **Classification**: The result is a continue opportunity when it completed with no error (turn ended), or when it carries a `copilotContinueOnError` confirmation button. `canceled` results and errors without a continue button are ignored.
3. **Trigger creation**: A `ContinueTrigger` is created with the session ID and pause reason.
4. **Guardrail check**: ContinueEngine consults Guardrails to verify a continue is permitted.
5. **Backoff scheduling**: A timer is set using exponential backoff with jitter.
6. **Active session check**: Before each attempt, the engine reads `state.vscdb` via sqlite3 to verify the paused session is still the active one.
7. **Execution**: The continue focuses the chat panel and submits the continue message via `workbench.action.chat.submit`.
8. **Resume**: The SessionWatcher detects when a paused session picks the work back up (a newer request appears) and cancels any active continue cycle.

## Challenges and How We Overcame Them

### Challenge 1: No Public API for Chat Session State

**Problem**: VS Code has no public extension API to observe whether a Copilot chat conversation has paused or ended. `ChatResponseTurn.result` is only available inside a chat participant's own response handler — not to third-party observers.

**Solution**: VS Code Core writes chat sessions to disk as JSONL files at `workspaceStorage/<hash>/chatSessions/<sessionId>.jsonl`. These files contain the full conversation state, including each request's `result`. The SessionWatcher monitors these files and classifies the latest result.

### Challenge 2: Understanding the JSONL Format

**Problem**: The JSONL session files use three kinds of entries that are not documented:

| Kind | Name | Meaning |
|---|---|---|
| `kind: 0` | Snapshot | Full conversation state — contains a `requests[]` array |
| `kind: 1` | Key-path patch | Updates a single nested property — e.g., `["requests", 0, "result"]` |
| `kind: 2` | Key replacement | Replaces an entire top-level key — e.g., the whole `requests` array |

**Solution**: We reverse-engineered the format from real session files. A completed request writes a `result` into `requests[N].result`. A clean turn-ended result has `metadata` and no `errorDetails`. A result that stopped and offers a continue carries `errorDetails.confirmationButtons` with `data.copilotContinueOnError: true`.

### Challenge 3: No Way to Press the Continue Button Programmatically

**Problem**: The built-in continue / "Try Again" button is proposed-only (`chatParticipantPrivate`), restricted to first-party extensions. `workbench.action.chat.retry` requires an internal view-model object and no-ops without it.

**Solution**: We use `workbench.action.chat.submit` with an `inputValue`. This submits the continue message in the current conversation. It costs one extra turn but preserves full context and is the only approach that works from a third-party extension.

### Challenge 4: Multi-Session Targeting

**Problem**: A single VS Code window can have multiple chat sessions. `workbench.action.chat.submit` always submits to the currently active (visible) chat widget. If the user switched sessions after a pause, the continue message would go to the wrong conversation.

**Solution**: We read the active session ID from `state.vscdb` — a SQLite database at `workspaceStorage/<hash>/state.vscdb`. The key `memento/interactive-session-view-copilot` contains JSON with a `sessionId` field matching the JSONL filename. We query it via the `sqlite3` CLI before each attempt. If the active session doesn't match the paused session, the continue is skipped.

This degrades gracefully: if `sqlite3` is unavailable, the database is locked, or the key is missing, we proceed (assume the correct session is active).

## Key Design Decision: Why "Chat Submit" Instead of the Continue Button

There is no public API for a third-party extension to trigger VS Code's internal continue button (see Challenge 3). The `chat.submit` approach is the only viable method.

**Trade-offs**:
- Sends a new turn in the conversation (costs one extra message)
- The agent sees its own paused state in history, plus our continue prompt
- Preserves full conversation context
- Works reliably from any third-party extension
- Does not depend on proposed or internal APIs

## Safety Guardrails

The `Guardrails` class enforces multiple safety constraints:

| Guardrail | Value | Purpose |
|---|---|---|
| Absolute rate limit | 15 continues per 60-second sliding window | Prevents runaway loops |
| Minimum interval | 1,000 ms between any two attempts | Prevents rapid-fire continues |
| Cycle cooldown | 60,000 ms after exhausting all attempts | Prevents immediate re-triggering |
| Extension enabled check | Must be enabled in settings | User kill switch |
| Active session check | Verifies paused session is still visible | Prevents continuing in wrong conversation |

Backoff calculation uses exponential delay with jitter: `base * 2^(attempt-1) * jitter(0.8..1.2)`, clamped to `maxDelayMs`.

## Known Limitations

1. **Session file format is undocumented** — The JSONL format (`kind: 0/1/2`) was reverse-engineered. VS Code could change it without notice. The extension degrades gracefully if parsing fails (no crash, just no detection).
2. **Cannot target a specific chat session** — `workbench.action.chat.submit` always goes to the focused chat widget. The `ActiveSessionResolver` mitigates this as a safety gate, not a targeting mechanism.
3. **`sqlite3` dependency for active session check** — Used to read `state.vscdb`. Pre-installed on macOS and most Linux distros; may be missing on Windows or minimal containers. Without it, the check is skipped (graceful degradation).
4. **Continuing adds a conversation turn** — Unlike the native continue button, submitting a message costs one additional LM turn.
5. **Single continue cycle at a time** — If multiple sessions pause simultaneously, only the first triggers a cycle until it completes or is cancelled.

## Development Setup

### Prerequisites

- Node.js 18+
- VS Code 1.90+

### Build

```bash
cd vscode-copilot-long-run
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
   - **Copilot Long Run: Show Status** to verify the extension is running
   - **Copilot Long Run: [Dev] Simulate Pause** to test the full continue pipeline end-to-end

### Project Structure

```
src/
  extension.ts                Entry point, wiring, command registration
  sessionWatcher.ts           Pause detection via chat session JSONL files
  activeSessionResolver.ts    Active session verification via state.vscdb (sqlite3)
  continueEngine.ts           Continue cycle management with exponential backoff
  guardrails.ts               Safety constraints and rate limiting
  statusBar.ts                Status bar UI
  logger.ts                   Output channel logging
  configuration.ts            Settings wrapper
  sessionWatcher.spec.ts      Tests: JSONL parsing and pause classification
  activeSessionResolver.spec.ts  Tests: sqlite3 integration and session matching
  guardrails.spec.ts          Tests: safety guardrail logic
  continueEngine.spec.ts      Tests: trigger factory methods
  __mocks__/
    vscode.ts                 Minimal vscode module mock for tests
```

## Code Conventions

- TypeScript strict mode
- No default exports
- Descriptive variable names (no abbreviations)
- All continue attempts must pass through `Guardrails.canContinue()` before execution
- All disposable resources must be registered in `context.subscriptions`
- Detection must be passive (no interception of Copilot's request pipeline)
- Zero runtime npm dependencies — only `vscode` (provided by the host) and dev dependencies

## Future Considerations

- If VS Code exposes an API to programmatically trigger confirmation buttons or continue chat responses, the continue mechanism should switch to it instead of the "chat submit" approach
- The `chatParticipantPrivate` proposed API may eventually become stable and accessible to third-party extensions
- If VS Code adds a public API for reading chat session state (active session, turn state), the filesystem approach can be replaced

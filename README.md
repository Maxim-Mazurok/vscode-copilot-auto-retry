# Copilot Long Run

<p align="center">
  <img src="assets/icon.png" alt="Copilot Long Run logo" width="128">
</p>

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Keeps GitHub Copilot agent sessions going.** When the agent pauses — its turn ends, or it stops to ask whether it should keep iterating — this extension automatically sends a continue message so a long-running task finishes while you're away.

---

## The Problem

You kick off a long task in Copilot agent mode, switch to something else, and expect it to be done when you come back. Instead, the agent completed a chunk of work and then just... stopped, waiting for you to tell it to keep going.

Now you have to context-switch back, type "continue", wait for the next chunk, and babysit it to completion — over and over — wasting the time you thought you were saving.

This extension fixes that. It detects when the agent has paused and **automatically nudges it forward** with a directive continue message.

## Features

- **Automatic continue on pause** — Monitors chat session files on disk and detects when the agent's turn has ended or it's presenting a "continue" button, then sends a continue message
- **Directive continue message** — Sends "Keep going until the task is fully complete." by default (configurable)
- **Multi-window safe** — Each VS Code window only monitors its own workspace sessions; continues never leak across windows
- **Multi-session safe** — Verifies the paused session is still the active one before sending, so it won't submit into the wrong conversation
- **Exponential backoff with jitter** — Spaces attempts out to avoid hammering the API (2s → 4s → 8s → ...)
- **Safety guardrails** — Hard rate limits (max 15 continues/minute), cooldown periods, and a kill switch to prevent runaway loops
- **Status bar indicator** — Shows current state at a glance: idle, waiting, continuing, cooldown, or disabled
- **Manual continue command** — Trigger a continue immediately with `Cmd+Shift+R` / `Ctrl+Shift+R`
- **Zero configuration** — Works out of the box with sensible defaults

## How It Works

1. VS Code writes Copilot chat sessions as JSONL files to disk. The extension watches these files for the latest request's result.
2. A session is considered **paused** (a continue opportunity) when either:
   - The latest request completed with no error — the agent's turn ended and it's idle; or
   - The latest result carries a continue / "Try Again" button — the agent is explicitly asking whether to keep going.
   
   User cancellations (pressing Stop) are never auto-continued.
3. When a pause is detected, a continue cycle begins with exponential backoff.
4. Before each attempt, the extension verifies the paused session is still the active one (to avoid submitting into the wrong conversation).
5. Each attempt focuses the chat panel and submits the continue message in the same conversation.

## Commands

| Command | Description |
|---|---|
| **Copilot Long Run: Enable** | Enable the extension |
| **Copilot Long Run: Disable** | Disable the extension and cancel active continues |
| **Copilot Long Run: Toggle Enabled** | Toggle on/off (also available by clicking the status bar item) |
| **Copilot Long Run: Continue Now** | Manually send a continue immediately (`Cmd+Shift+R` / `Ctrl+Shift+R`) |
| **Copilot Long Run: Show Status** | Display detailed status in the output channel |

## Settings

All settings are under `copilotLongRun.*` in VS Code Settings.

| Setting | Default | Description |
|---|---|---|
| `copilotLongRun.enabled` | `true` | Enable automatically continuing paused agent sessions |
| `copilotLongRun.continueMessage` | `Keep going until the task is fully complete.` | The message sent to the agent when a pause is detected |
| `copilotLongRun.maxContinues` | `3` | Maximum continue attempts per detected pause (1–10) |
| `copilotLongRun.baseDelayMs` | `2000` | Base delay before the first continue in milliseconds (500–15,000) |
| `copilotLongRun.maxDelayMs` | `30000` | Maximum backoff cap in milliseconds (5,000–120,000) |

## What Counts as a Pause?

The extension reads chat session JSONL files and classifies the latest request's result:

| Result | Continues? |
|---|---|
| **Turn ended** (completed, no error) | Yes |
| **Continue / "Try Again" button** (e.g. `rateLimited`, `networkError`) | Yes |
| **User cancellation** (`canceled`) | No (user-initiated) |
| **Error without a continue button** | No (nothing to nudge) |

## Status Bar

The status bar item (right side) shows the current state:

| Icon | State | Meaning |
|---|---|---|
| $(check) Long Run | **Idle** | Monitoring normally, no pause detected |
| $(clock) Continue 1/3 | **Waiting** | Backoff timer counting down before next attempt |
| $(sync~spin) Continuing 1/3 | **Continuing** | Sending a continue right now |
| $(warning) Long Run Cooldown | **Cooldown** | All continues exhausted, waiting before resuming |
| $(x) Long Run: Off | **Disabled** | Extension is disabled |

Click the status bar item to toggle the extension on/off.

## Limitations

- **Continuing adds a message to the conversation** — There is no public API to press the built-in continue button. The extension submits a follow-up message instead, which adds one extra turn.
- **Cannot target a specific session** — `workbench.action.chat.submit` always goes to the currently active chat widget. The extension mitigates this by checking which session is active before continuing, and skipping if the user switched away.
- **Relies on VS Code internal file layout** — Session files are stored in `workspaceStorage/<hash>/chatSessions/`. If VS Code changes this layout, the extension will stop detecting pauses (but won't break anything — it degrades gracefully).
- **Active session check requires `sqlite3` CLI** — On macOS and most Linux systems, `sqlite3` is pre-installed. Where it's missing, the active-session verification is skipped (continue proceeds without the safety check).
- **Single continue at a time** — If multiple sessions pause in the same window, only the first triggers a continue cycle until it completes.

## Requirements

- VS Code 1.90 or later
- GitHub Copilot extension installed

## Privacy

This extension:

- **Reads only result metadata** from chat session files (result/error codes and button data) — it does not read your prompts, responses, or conversation content
- **Does not send** any data to external services (beyond VS Code's built-in commands)
- **Does not wrap** or intercept Copilot's request pipeline

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for architecture details, design decisions, and development setup.

## Credits

Based on [vscode-copilot-auto-retry](https://github.com/Maxim-Mazurok/vscode-copilot-auto-retry) by [Max Mazurok](https://github.com/Maxim-Mazurok), reworked from automatic error retry into keeping long-running agent sessions going.

## License

[MIT](LICENSE)

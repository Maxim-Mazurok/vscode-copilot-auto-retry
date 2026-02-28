# Copilot Auto-Retry

<p align="center">
  <img src="assets/icon.png" alt="Copilot Auto-Retry logo" width="128">
</p>

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/MaximMazurok.vscode-copilot-auto-retry?label=VS%20Code%20Marketplace&logo=visual-studio-code&color=blue)](https://marketplace.visualstudio.com/items?itemName=MaximMazurok.vscode-copilot-auto-retry)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/MaximMazurok.vscode-copilot-auto-retry?logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=MaximMazurok.vscode-copilot-auto-retry)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/MaximMazurok.vscode-copilot-auto-retry?logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=MaximMazurok.vscode-copilot-auto-retry)
[![Open VSX](https://img.shields.io/open-vsx/v/MaximMazurok/vscode-copilot-auto-retry?label=Open%20VSX&color=purple)](https://open-vsx.org/extension/MaximMazurok/vscode-copilot-auto-retry)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Automatically retries transient GitHub Copilot failures** — rate limits, network errors, and service disruptions — so you don't have to sit and click "Try Again" manually.

---

## The Problem

You kick off a task in Copilot agent mode, switch context to something else, and expect it to be done when you come back. Instead, somewhere in the middle, Copilot hit a rate limit or a network blip:

> **Sorry, you have exhausted this model's rate limit. Please wait a moment before trying again, or switch to GPT-4.1. [Learn More](https://aka.ms/copilot-rate-limits)**

Now instead of a completed task, you're staring at a half-finished result and a "Try Again" button. You have to context-switch back, click retry, wait, and babysit it to completion — wasting the time you thought you were saving.

This extension fixes that. It **automatically retries** transient failures with exponential backoff so Copilot keeps working while you're away.

## Features

- **Automatic retry on rate limits and network errors** — Monitors chat session files on disk for Copilot errors with a "Try Again" button and retries automatically
- **Network recovery** — Monitors connectivity to GitHub/Copilot endpoints and retries when your network comes back online
- **Multi-window safe** — Each VS Code window only monitors its own workspace sessions; retries never leak across windows
- **Multi-session safe** — Verifies the errored session is still the active one before retrying, so it won't submit a retry prompt into the wrong conversation
- **Exponential backoff with jitter** — Spreads retries over time to avoid hammering the API (2s → 4s → 8s → ...)
- **Safety guardrails** — Hard rate limits (max 15 retries/minute), cooldown periods, and a kill switch to prevent runaway loops
- **Status bar indicator** — Shows current state at a glance: idle, waiting, retrying, cooldown, or disabled
- **Manual retry command** — Trigger a retry immediately with `Cmd+Shift+R` / `Ctrl+Shift+R`
- **Zero configuration** — Works out of the box with sensible defaults

## Install

### VS Code Marketplace

**[Install from VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=MaximMazurok.vscode-copilot-auto-retry)**

Or search for **"Copilot Auto-Retry"** in the VS Code Extensions view (`Cmd+Shift+X` / `Ctrl+Shift+X`).

### Open VSX (for VS Codium, Gitpod, Theia, etc.)

**[Install from Open VSX](https://open-vsx.org/extension/MaximMazurok/vscode-copilot-auto-retry)**

## How It Works

1. VS Code writes Copilot chat sessions as JSONL files to disk. The extension watches these files for error entries (rate limits, network errors) that have a "Try Again" button.
2. When a retryable error is detected, a retry cycle begins with exponential backoff.
3. Before each retry attempt, the extension verifies the errored session is still the active one (to avoid submitting a retry prompt into the wrong conversation).
4. Each retry focuses the chat panel and submits a follow-up message asking Copilot to continue.
5. A separate network monitor detects connectivity recovery (offline → online) and triggers a retry if there's an active error in the current window.

## Commands

| Command | Description |
|---|---|
| **Copilot Auto-Retry: Enable** | Enable the extension |
| **Copilot Auto-Retry: Disable** | Disable the extension and cancel active retries |
| **Copilot Auto-Retry: Toggle Enabled** | Toggle on/off (also available by clicking the status bar item) |
| **Copilot Auto-Retry: Retry Now** | Manually trigger an immediate retry (`Cmd+Shift+R` / `Ctrl+Shift+R`) |
| **Copilot Auto-Retry: Show Status** | Display detailed status in the output channel |

## Settings

All settings are under `copilotAutoRetry.*` in VS Code Settings.

| Setting | Default | Description |
|---|---|---|
| `copilotAutoRetry.enabled` | `true` | Enable automatic retry of transient failures |
| `copilotAutoRetry.maxRetries` | `3` | Maximum retry attempts per failure (1–10) |
| `copilotAutoRetry.baseDelayMs` | `2000` | Base delay before first retry in milliseconds (500–15,000) |
| `copilotAutoRetry.maxDelayMs` | `30000` | Maximum backoff cap in milliseconds (5,000–120,000) |

## What Errors Does It Handle?

The extension detects errors by reading chat session JSONL files. It retries errors that have a `copilotContinueOnError` confirmation button (the "Try Again" button).

| Error Type | Error Code | Retried? |
|---|---|---|
| **Rate limits** | `rateLimited` | Yes |
| **Network errors** | `networkError` | Yes |
| **User cancellation** | `canceled` | No (user-initiated) |

Other error codes with a "Try Again" button are also retried. Errors without the button are ignored.

## Status Bar

The status bar item (right side) shows the current state:

| Icon | State | Meaning |
|---|---|---|
| $(check) Copilot Retry | **Idle** | Monitoring normally, no errors detected |
| $(clock) Retry 1/3 | **Waiting** | Backoff timer counting down before next attempt |
| $(sync~spin) Retrying 1/3 | **Retrying** | Executing a retry right now |
| $(warning) Retry Cooldown | **Cooldown** | All retries exhausted, waiting before resuming |
| $(x) Copilot Retry: Off | **Disabled** | Extension is disabled |

Click the status bar item to toggle the extension on/off.

## Limitations

- **Retries add a message to the conversation** — There is no public API to press the "Try Again" button. The extension submits a follow-up prompt instead, which adds one extra turn. The AI sees the error in history and is asked to retry the same operation.
- **Cannot target a specific session** — `workbench.action.chat.submit` always goes to the currently active chat widget. The extension mitigates this by checking which session is active before retrying, and skipping if the user switched away.
- **Relies on VS Code internal file layout** — Session files are stored in `workspaceStorage/<hash>/chatSessions/`. If VS Code changes this layout, the extension will stop detecting errors (but won't break anything — it degrades gracefully).
- **Active session check requires `sqlite3` CLI** — On macOS and most Linux systems, `sqlite3` is pre-installed. On systems where it's missing, the active-session verification is skipped (retry proceeds but without the safety check).
- **Single retry at a time** — If multiple errors occur across different sessions in the same window, only the first triggers a retry cycle. Subsequent errors are ignored until the cycle completes.

## Requirements

- VS Code 1.90 or later
- GitHub Copilot extension installed

## Privacy

This extension:

- **Reads only error metadata** from chat session files (error codes and button data) — it does not read your prompts, responses, or conversation content
- **Does not send** any data to external services (beyond VS Code's built-in commands)
- **Does not wrap** or intercept Copilot's request pipeline
- Network probes send HTTP HEAD requests to `api.github.com` and Copilot endpoints only to check reachability

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for architecture details, design decisions, and development setup.

## License

[MIT](LICENSE)

---

<sub>This extension was AI-generated with Claude Opus 4.6 (Anthropic) under human supervision by [Max Mazurok](https://github.com/Maxim-Mazurok).</sub>

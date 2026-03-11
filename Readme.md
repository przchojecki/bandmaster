# Bandmaster

Bandmaster is a TypeScript CLI that helps you configure and run a two-model workflow:
- a **Worker** model for implementation
- a **Manager** model for checkpoint guidance

It currently provides:
- an interactive setup wizard (`bandmaster` / `bandmaster init`)
- TOML config generation and validation (`.bandmaster/project.toml`)
- a quick execution loop that invokes provider CLIs
- a non-interactive config validation command (`bandmaster run`)

## Current Status

This repository is an early scaffold (`v0.1.1`).

Implemented now:
- interactive configuration menu
- provider auth mode setup (API key env var or subscription command)
- `run` command that validates config and reports effective settings
- "Quick Run" loop (round-based or hour-based) that launches worker/manager CLIs

Not implemented yet:
- full orchestration engine/state machine
- persistent session history/checkpoint storage
- provider adapters with normalized event protocol

## Requirements

- Node.js (modern LTS recommended)
- npm
- Provider CLIs on `PATH` for models you want to execute:
  - `codex`
  - `claude`
  - `gemini`
  - `ollama`

If a CLI binary is missing, Bandmaster will print the expected command and continue.

## Install

### From source (local development)

```bash
npm install
npm run build
```

Run locally:

```bash
npm run bandmaster
```

### Global install from this repo

```bash
npm install
npm run build
npm link
```

Then use:

```bash
bandmaster --help
```

## CLI Commands

### `bandmaster`

Starts the interactive init wizard (same as `bandmaster init`).

### `bandmaster init [--config <path>]`

Opens the interactive menu to configure:
- worker model (+ optional fallback)
- manager model (+ optional fallback)
- provider connection mode (`api` or `subscription`)
- policy and budget settings
- project metadata (`name`, `objective`, `workspace`, `entryDocs`)

When you choose **Run AI work**, the wizard writes config to disk and runs `bandmaster run`.

### `bandmaster run [--config <path>]`

Loads and validates project config, then prints a run summary:
- worker/manager model selections
- connection mode for each provider
- policy, session budget, cycle budget, stop mode
- missing entry docs (warning)

Note: this command currently validates and reports settings. It does not start a long-running orchestrated agent session.

## Interactive Menu

Main menu items:
1. Configure worker LLM
2. Configure manager LLM
3. Settings
4. Run AI work (project/docs + save + run)
5. Quick Run (inline prompt + rounds/hours)
6. Exit without saving

### Quick Run behavior

Quick Run executes a simple loop:
1. runs the worker model with a round prompt
2. optionally runs the manager model for concise direction
3. repeats by round count or time window

Enforcement details:
- enforced: selected quick-run mode (`rounds` or `hours`)
- advisory only: `budget.maxTokens`, `budget.maxTurns`, `budget.cycle.*`, `stopMode`

## Configuration File

Default path:
- `.bandmaster/project.toml`

You can override with `--config`.

### Minimal example

```toml
[project]
name = "my-project"
objective = "Implement the README requirements."
workspace = "."
entryDocs = ["README.md"]

[worker.primary]
provider = "codex"
model = "gpt-5.3-codex"

[pm.primary]
provider = "claude"
model = "claude-opus-4-1"

[pm.userProxy]
enabled = true
permissionScope = "delegated-safe"
guidanceStyle = "direct-and-push-forward"

[policy]
mode = "safe-only"

[checkpoint]
intervalMinutes = 20

[dialogue]
enableWorkerPmLoop = true
interveneOnPermission = true
interveneOnDirectionRequest = true
interveneOnStall = true
stallMinutes = 8

[budget]
maxMinutes = 480
maxTokens = 1500000
maxTurns = 400
stopMode = "drain"

[budget.cycle]
maxTokens = 60000
maxTurns = 24

[providers.codex.auth]
mode = "subscription"
subscriptionCommand = "codex login"

[providers.claude.auth]
mode = "subscription"
subscriptionCommand = "claude setup-token"
```

## Provider Auth Configuration

For each provider in `[providers.<name>.auth]`:

- `mode = "api"` requires `apiKeyEnv`
- `mode = "subscription"` requires `subscriptionCommand`

Example API mode:

```toml
[providers.gemini.auth]
mode = "api"
apiKeyEnv = "GEMINI_API_KEY"
```

Example subscription mode:

```toml
[providers.gemini.auth]
mode = "subscription"
subscriptionCommand = "gemini auth login"
```

## Development

```bash
npm install
npm run check
npm run build
npm run dev
```

## Troubleshooting

- `Interactive init requires a TTY terminal.`
  - Run `bandmaster` in an interactive terminal, not in a non-TTY pipeline.
- `Failed to read config file ...`
  - Ensure `.bandmaster/project.toml` exists or pass `--config`.
- `Invalid project config ...`
  - Fix TOML syntax or required fields shown in validation errors.
- `Binary "<name>" not found on PATH.`
  - Install that provider's CLI and retry.

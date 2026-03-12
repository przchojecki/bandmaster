# Bandmaster

Bandmaster is a TypeScript CLI that helps you configure and run a two-model workflow:
- a **Worker** model for implementation
- a **Manager** model for checkpoint guidance

It currently provides:
- an interactive setup wizard (`bandmaster` / `bandmaster init`)
- TOML config generation and validation (`.bandmaster/project.toml`)
- a quick execution loop that invokes provider CLIs
- a non-interactive config validation command (`bandmaster run`)
- a metric-driven optimization loop (`bandmaster loop`)
- session history viewing (`bandmaster history`)
- collaborative swarm mode (`bandmaster swarm`, `bandmaster loop --swarm`)
- automated release flow (`bandmaster release`)

## Current Status

This repository is an early scaffold (`v0.1.5`).

Implemented now:
- interactive configuration menu
- provider auth mode setup (API key env var or subscription command)
- `run` command that validates config and reports effective settings
- "Quick Run" loop (round-based or hour-based) that launches worker/manager CLIs
- `loop` command that keeps/discards candidate commits by evaluation metric
- swarm claim/publish/sync flow with file-backed shared state

Not implemented yet:
- full orchestration engine/state machine
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

### `bandmaster loop [options]`

Runs a closed loop for complex tasks:
1. worker model edits the codebase
2. Bandmaster creates a candidate commit
3. evaluation command runs (benchmark/test/research harness)
4. metric is extracted from output via regex
5. candidate is kept or discarded based on metric improvement

Core options:
- `--run-command "<cmd>"` evaluation command per round
- `--metric-pattern "<regex>"` regex for metric extraction
- `--metric-json-path "<path>"` JSON metric path (alternative to regex)
- `--optimize max|min` metric direction
- `--keep-threshold <number>` minimum improvement required
- `--max-rounds <number>`
- `--timeout-seconds <number>`
- `--edit-scope "glob1,glob2"` allowed edit paths
- `--branch <name>` / `--no-create-branch`
- `--swarm` / `--no-swarm`
- `--swarm-root <path>`
- `--swarm-id <id>`
- `--agent-id <id>`

The command writes run logs to `.bandmaster/sessions/<timestamp>-loop/`:
- `results.tsv`
- `events.jsonl`

When swarm mode is enabled, each round also:
- attempts a claim to reduce duplicate work
- publishes round results and manager insight/hypothesis
- updates shared best with race-safe compare/update
- periodically syncs from shared best patch artifact
- falls back to local-only operation if swarm backend is unavailable

### `bandmaster history [options]`

Reads loop sessions from `.bandmaster/sessions` and prints:
- recent session summaries by default
- detailed per-round output when `--session <id>` is provided

Options:
- `--limit <number>` number of recent sessions to show (default `10`)
- `--session <id>` show detailed output for one session

### `bandmaster release <version> [options]`

Automates:
1. clean-tree check
2. `npm version --no-git-tag-version`
3. README version update
4. changelog entry generation
5. release commit + annotated tag
6. optional push of commit/tag

Options:
- `--no-push` skip pushing to origin
- `--changelog-file <path>` changelog path (default `CHANGELOG.md`)
- `--tag-message <text>` custom annotated tag message

### `bandmaster swarm join [options]`

Joins a swarm and persists local agent identity in `.bandmaster/swarm-agent.json`.

### `bandmaster swarm status [options]`

Shows:
- current agent id
- swarm id and backend root
- active claim count
- total published results and insights
- best shared metric record

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

[loop]
runCommand = "npm test -- --runInBand"
metricPattern = "score:\\s*([0-9.]+)"
# alternatively:
# metricJsonPath = "metrics.score"
metricSource = "combined"
optimize = "max"
keepThreshold = 0
maxRounds = 12
timeoutSeconds = 1800
editScope = ["src/**", "tests/**", "package.json"]

[swarm]
enabled = false
backend = "file"
root = ".bandmaster/swarm"
swarmId = "default"
# agentId is optional; generated or reused from .bandmaster/swarm-agent.json
claimTtlSeconds = 1200
syncEveryNRounds = 3
maxMetricJump = 1000000

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

Loop example:

```bash
npm run bandmaster -- loop \
  --config .bandmaster/project.toml \
  --run-command "npm test -- --runInBand" \
  --metric-pattern "score:\\s*([0-9.]+)" \
  --optimize max \
  --max-rounds 10 \
  --edit-scope "src/**,tests/**"
```

Loop JSON metric example:

```bash
npm run bandmaster -- loop \
  --config .bandmaster/project.toml \
  --run-command "node scripts/eval.js" \
  --metric-json-path "metrics.score" \
  --metric-source stdout \
  --optimize max
```

Swarm examples:

```bash
# join a shared swarm namespace (once per machine/workspace)
npm run bandmaster -- swarm join \
  --config .bandmaster/project.toml \
  --swarm-root /shared/bandmaster-swarm \
  --swarm-id research-team-a

# check shared swarm status
npm run bandmaster -- swarm status \
  --config .bandmaster/project.toml \
  --swarm-root /shared/bandmaster-swarm \
  --swarm-id research-team-a

# run loop with swarm coordination
npm run bandmaster -- loop \
  --config .bandmaster/project.toml \
  --swarm \
  --swarm-root /shared/bandmaster-swarm \
  --swarm-id research-team-a
```

Release examples:

```bash
# release + push
npm run bandmaster -- release 0.1.5

# release only locally (no push)
npm run bandmaster -- release patch --no-push
```

History examples:

```bash
# show last 10 loop sessions
npm run bandmaster -- history --config .bandmaster/project.toml

# show last 3 sessions
npm run bandmaster -- history --config .bandmaster/project.toml --limit 3

# show one session in detail
npm run bandmaster -- history --config .bandmaster/project.toml --session 2026-03-11T10-30-00-000Z-loop
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

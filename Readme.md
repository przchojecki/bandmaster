# Bandmaster CLI Plan (TypeScript-First)

## Goal
Build an interactive CLI orchestrator (inspired by UlamAI behavior and OpenClaw architecture) that can run long tasks across:
- Codex
- Claude
- Gemini
- Ollama

Bandmaster will:
- Use a **worker model (LLM1)** for implementation.
- Use a **project manager model (LLM2)** for critique/planning/checkpoints.
- Support an explicit **LLM1 <-> LLM2 dialogue loop**.
- Bound execution by configurable **time, token, and turn budgets**.
- Auto-handle worker permission requests by policy.
- Ask whether to continue, modify, or stop when budgets/checkpoints are reached.

## Why TypeScript
- Strong shared contracts across providers, orchestration engine, and UI.
- Easier cross-LLM coding collaboration via explicit types and schema validation.
- Mature Node ecosystem for CLI/TUI, streaming, and process control.
- Better long-term maintainability for multi-provider adapters.

## Stack Decision
- Runtime: Node.js 22+
- Language: TypeScript (strict mode)
- Package manager: pnpm
- CLI framework: `oclif` + `@clack/prompts`
- Live run view: Ink (React TUI)
- Validation: Zod (or TypeBox)
- Storage: JSON/JSONL in `.bandmaster/`

## Product Scope (MVP)
1. Interactive setup wizard and `run/resume/history` commands.
2. Provider adapter interface for Codex/Claude/Gemini/Ollama.
3. Dual-agent orchestration loop (worker + PM) with budget guards.
4. Permission policy engine (`auto`, `safe-only`, `manual`).
5. Session persistence with audit trails and resume support.

## OpenClaw-Inspired Design Choices (Implementation)
- Typed protocol boundary (`request`, `response`, `event`) between adapters and core.
- Session-lane execution model (single active lane per session).
- Approval/resume flow with stable IDs and resume tokens.
- Primary + fallback model strategy per role.
- Wizard-first onboarding.

## UlamAI-Inspired Design Choices (Behavior)
- Iterative dialogue between specialized roles rather than one-shot prompting.
- Bounded run windows (time/tokens/turns) for predictable long-running sessions.
- Structured checkpoints: proposal -> critique -> revise -> execute.
- Explicit continuation prompts after each bounded dialogue cycle.

## Core User Flow
1. User runs `bandmaster run`.
2. Wizard asks:
- project path
- worker provider/model (primary + fallback)
- PM provider/model (primary + fallback)
- session budget (e.g., 180 minutes)
- dialogue budget per cycle (max tokens + max turns)
- permission policy (`auto`, `safe-only`, `manual`)
3. Orchestrator starts worker run and streams events.
4. On `permission_request`, policy engine approves/denies/escalates.
5. At checkpoints, worker and PM run bounded dialogue turns until cycle budget is exhausted or `done/blocked` is reached.
6. CLI asks: `continue / modify plan / stop`.
7. Session loops until user stops or global budget expires.

## EXAMPLARY WORKFLOW
### Scenario: New Folder, Build a Game, Run for 8 Hours
1. User creates a new project folder with:
- `README.md` containing the product brief (for example: "build a 2D browser game")
- optional supporting files (`TASKS.md`, `DESIGN.md`, asset notes, constraints)
2. User launches `bandmaster run` and configures:
- worker model (LLM1)
- PM/user-proxy model (LLM2)
- session budget: `8 hours`
- cycle budget: max tokens + max turns
- permission policy: `safe-only` or delegated policy
- stop behavior: `drain` (no hard stop)
3. Bandmaster starts execution:
- LLM1 reads the project docs and begins implementation.
- LLM2 stays in supervisory mode until needed.
4. LLM2 activates whenever LLM1 pauses:
- LLM1 asks for permission.
- LLM1 asks for direction/clarification.
- progress stalls (timeout/no-progress heuristic).
- checkpoint boundary is reached.
5. LLM2 acts as delegated user proxy:
- answers LLM1 questions as if it were the user representative
- can approve/deny/modify permission requests inside policy guardrails
- can push LLM1 with next steps, decomposition, and recovery directions
6. During the 8-hour window:
- Bandmaster keeps alternating LLM1 execution and LLM2 interventions as needed.
- all approvals, interventions, and rationale are logged.
7. At 8 hours:
- Bandmaster marks budget exhausted and stops starting new cycles.
- LLM1 is allowed to finish the active task/turn (graceful drain).
- once LLM1 completes that in-flight work, Bandmaster closes the run and produces a final checkpoint summary.
8. Session ends with:
- artifact summary
- open issues and risks
- recommended next run objective
- option to continue in a new budget window

## Architecture
### 1) Typed Event Protocol
Normalized events:
- `message`
- `tool_call`
- `permission_request`
- `permission_decision`
- `handoff` (worker -> PM, PM -> worker)
- `dialogue_turn`
- `checkpoint`
- `budget_exhausted`
- `task_completed`
- `error`
- `usage`

Each event includes:
- `sessionId`
- `eventId`
- `ts`
- `provider`
- `payload` (typed by event kind)

### 2) Provider Adapter Interface
```ts
interface ProviderAdapter {
  startSession(config: ProviderSessionConfig): Promise<{ sessionId: string }>;
  sendPrompt(input: WorkerTurnInput): AsyncIterable<ProviderEvent>;
  respondPermission(input: PermissionDecisionInput): Promise<void>;
  stopSession(input: { sessionId: string }): Promise<void>;
}
```

### 3) Orchestration Engine
Responsibilities:
- session state machine
- lane serialization
- permission policy routing
- dialogue scheduler invocation
- checkpoint scheduling
- budget enforcement (time/tokens/turns)
- model fallback routing

State machine:
- `CONFIGURED -> RUNNING -> DIALOGUE -> CHECKPOINT -> USER_DECISION -> RUNNING | DONE | BLOCKED`

### 4) Dual-Agent Dialogue Scheduler
Cycle model:
- Step A: worker proposes action/progress.
- Step B: PM critiques and suggests next steps.
- Step C: worker revises plan or executes.
- Repeat until:
- cycle token cap reached
- cycle turn cap reached
- PM outputs `done` or `blocked`

Outputs per cycle:
- cycle summary
- risks
- next actions
- continuation recommendation

### 5) Permission Policy Engine
Modes:
- `auto`: approve all known requests.
- `safe-only`: approve read/test/non-destructive actions, escalate risk.
- `manual`: always ask user.

Classifier categories:
- read-only file ops
- non-destructive local commands
- write/modify commands
- package installs
- network access
- destructive commands (delete/reset/force)

### 6) PM Model Module
PM input:
- objective
- transcript since previous checkpoint
- diff summary
- test/status outputs
- unresolved blockers

PM output schema:
- `status`: `done | continue | blocked`
- `summary`
- `nextSteps`
- `riskFlags`
- `recommendedAction`

### 7) Persistence + Resume
Session data under `.bandmaster/sessions/<timestamp>-<id>/`:
- `config.json`
- `events.jsonl`
- `transcript.md`
- `checkpoints.jsonl`
- `approval-log.jsonl`
- `cycle-log.jsonl`
- `metrics.json`
- `resume.json`

## Project Layout (Proposed)
```text
bandmaster/
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  apps/
    cli/
      src/
        commands/
          run.ts
          resume.ts
          history.ts
        tui/
          live-view.tsx
          decision-prompt.tsx
        index.ts
  packages/
    core/
      src/
        orchestrator/
        state-machine/
        checkpoints/
    protocol/
      src/
        events.ts
        requests.ts
        schemas.ts
    dialogue/
      src/
        scheduler.ts
        budget-guard.ts
        handoff.ts
    providers/
      src/
        codex/
        claude/
        gemini/
        ollama/
        adapter.ts
    policy/
      src/
        permission-engine.ts
        risk-classifier.ts
    storage/
      src/
        session-store.ts
        event-log.ts
    config/
      src/
        load-config.ts
        schema.ts
```

## Configuration Model
Global: `~/.bandmaster/config.toml`
Project-local: `.bandmaster/project.toml`

Reference example in this repo:
- `.bandmaster/project.toml` (8-hour delegated run, LLM2 user-proxy enabled, graceful drain)

Key fields:
- `worker.primary.provider`, `worker.primary.model`
- `worker.fallback[]`
- `pm.primary.provider`, `pm.primary.model`
- `pm.fallback[]`
- `pm.userProxy.enabled`
- `pm.userProxy.permissionScope`
- `policy.mode`
- `checkpoint.intervalMinutes`
- `budget.maxMinutes`
- `budget.maxTokens`
- `budget.maxTurns`
- `budget.cycle.maxTokens`
- `budget.cycle.maxTurns`
- `budget.stopMode` (`drain` | `hard`)
- `providers.<name>.auth`

## Implementation Phases
### Phase 1: Monorepo + CLI Skeleton
- Initialize TS monorepo and strict lint/test setup.
- Add `bandmaster run|resume|history`.
- Add wizard and config load/validate.

### Phase 2: Protocol + Core Loop
- Implement protocol schemas and event bus.
- Build session state machine + persistence.
- Implement live event stream in CLI UI.

### Phase 3: Codex Adapter First
- Build Codex adapter end-to-end.
- Support permission request/decision round-trip.
- Add checkpoint trigger hooks.

### Phase 4: Dual-Agent Dialogue + Budgets
- Implement worker <-> PM scheduler.
- Enforce cycle/session budgets (time/tokens/turns).
- Add continuation decision prompt after each cycle.

### Phase 5: Multi-Provider Expansion
- Implement Claude/Gemini/Ollama adapters.
- Normalize provider-specific events to protocol schema.
- Add primary/fallback routing per role.

### Phase 6: Policy Hardening + Resume
- Implement `safe-only` classifier rules.
- Add full approval audit logs and resume tokens.
- Improve interruption recovery.

### Phase 7: Stabilization
- Integration tests with mock providers.
- Long-run reliability tests.
- Cost/token/latency metrics and history views.

## Testing Strategy
- Unit:
- protocol schema validation
- config parsing and defaults
- policy decisions
- state transitions
- dialogue scheduler and budget guard
- PM parser
- Integration:
- mock provider emitting permission + completion events
- worker <-> PM cycle with token/turn caps
- resume from interrupted session
- E2E:
- `bandmaster run` against Codex adapter in sandbox project

## Immediate Next Tasks
1. Create TS monorepo scaffold and command entrypoints.
2. Implement `packages/protocol` schemas.
3. Implement `packages/dialogue` scheduler + budget guard.
4. Implement `packages/core` orchestrator/state machine + event log.
5. Implement Codex adapter and manual approval flow.
6. Add PM checkpoint dialogue loop and continue/modify/stop prompt.

## Current Scaffold Usage
1. Install dependencies:
- `pnpm install`
2. Open interactive menu (default command):
- `pnpm run bandmaster`
3. Optional direct wizard command:
- `pnpm run bandmaster -- init --config .bandmaster/project.toml`
4. Validate and load current project config:
- `pnpm run bandmaster -- run --config .bandmaster/project.toml`
5. npm fallback (if pnpm is unavailable):
- `npm install`
- `npm run bandmaster`
- `npm run bandmaster -- init --config .bandmaster/project.toml`
- `npm run bandmaster -- run --config .bandmaster/project.toml`

Global install (run from this repo):
- `npm run build`
- `npm link`
- then use `bandmaster` from any folder

Menu sections:
- `1. Configure worker LLM`
- `2. Configure manager LLM`
- `3. Settings`
- `4. Run AI work` (collect project/docs, save config, and immediately run)
- `5. Quick Run` (inline worker prompt + choose rounds/hours, then immediately run)

Subscription authentication flow:
- Selecting `Subscription` immediately launches auth (no extra submenu).
- Codex: runs `codex login`
- Claude: runs `claude setup-token`
- Gemini: runs `gemini auth login`
- Auth is reused per provider within the same menu session (no double login for Worker/Manager on same provider).

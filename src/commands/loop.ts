import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadProjectConfig } from "../config/index.js";
import type { ProjectConfig, ProviderName } from "../config/index.js";
import { createSwarmBackendFromProject } from "../swarm/config.js";
import type { FileSwarmBackend, SwarmBestRecord } from "../swarm/file-backend.js";
import { normalizeSwarmKey } from "../swarm/file-backend.js";

type MetricSource = "stdout" | "stderr" | "combined";
type OptimizeDirection = "max" | "min";
type Role = "worker" | "manager" | "system";

export interface LoopCommandOptions {
  config?: string;
  cwd?: string;
  prompt?: string;
  runCommand?: string;
  metricPattern?: string;
  metricJsonPath?: string;
  metricSource?: MetricSource;
  optimize?: OptimizeDirection;
  keepThreshold?: number;
  maxRounds?: number;
  timeoutSeconds?: number;
  editScope?: string;
  branch?: string;
  createBranch?: boolean;
  swarm?: boolean;
  swarmRoot?: string;
  swarmId?: string;
  agentId?: string;
}

interface Invocation {
  binary: string;
  args: string[];
  display: string;
}

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

interface LoopInterruptControl {
  interrupted: boolean;
  signal: "SIGINT" | "SIGTERM" | null;
  activeChild: ChildProcess | null;
}

class LoopInterruptedError extends Error {
  constructor() {
    super("Loop interrupted");
    this.name = "LoopInterruptedError";
  }
}

interface RoundResult {
  round: number;
  candidateCommit: string | null;
  workerExitCode: number;
  evalExitCode: number | null;
  metric: number | null;
  decision: "keep" | "discard" | "skip";
  reason: string;
  insight?: string;
  hypothesis?: string;
  optimize?: OptimizeDirection;
}

function roleLabel(role: Role): string {
  if (role === "worker") {
    return "[Worker]";
  }
  if (role === "manager") {
    return "[Manager]";
  }
  return "[System]";
}

function timestampForPath(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function normalizeEditScope(raw: string | undefined, fallback: string[]): string[] {
  if (!raw) {
    return fallback;
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parsePositiveInt(raw: number | undefined, fallback: number, fieldName: string): number {
  const value = raw ?? fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }
  return value;
}

function parseNumber(raw: number | undefined, fallback: number, fieldName: string): number {
  const value = raw ?? fallback;
  if (!Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number.`);
  }
  return value;
}

function chooseMetricSource(
  preferred: MetricSource | undefined,
  configSource: MetricSource | undefined
): MetricSource {
  return preferred ?? configSource ?? "combined";
}

function chooseOptimize(
  preferred: OptimizeDirection | undefined,
  configValue: OptimizeDirection | undefined
): OptimizeDirection {
  return preferred ?? configValue ?? "max";
}

function globToRegExp(glob: string): RegExp {
  const placeholder = "\u0000";
  let source = glob.replace(/\*\*/g, placeholder);
  source = source.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  source = source.replace(/\*/g, "[^/]*");
  source = source.replace(new RegExp(placeholder, "g"), ".*");
  return new RegExp(`^${source}$`);
}

function isPathAllowed(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(filePath));
}

export function parseMetricPattern(input: string): RegExp {
  const literal = input.match(/^\/(.+)\/([a-z]*)$/i);
  if (!literal) {
    return new RegExp(input, "m");
  }
  const body = literal[1];
  const flags = literal[2] ?? "";
  if (!body) {
    throw new Error("metricPattern regex body cannot be empty.");
  }
  return new RegExp(body, flags);
}

export function parseMetricFromOutput(pattern: RegExp, text: string): number | null {
  const safeFlags = pattern.flags.replace(/g/g, "").replace(/y/g, "");
  const safePattern = new RegExp(pattern.source, safeFlags);
  const match = safePattern.exec(text);
  if (!match) {
    return null;
  }

  const groupValue =
    typeof match.groups?.metric === "string"
      ? match.groups.metric
      : typeof match[1] === "string"
        ? match[1]
        : match[0];

  const numericMatch = groupValue.match(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/);
  if (!numericMatch) {
    return null;
  }

  const parsed = Number.parseFloat(numericMatch[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseMetricFromJsonPath(jsonText: string, jsonPath: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }

  const segments = jsonPath
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return null;
  }

  let cursor: unknown = parsed;
  for (const segment of segments) {
    if (typeof cursor !== "object" || cursor === null || !(segment in cursor)) {
      return null;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }

  if (typeof cursor === "number" && Number.isFinite(cursor)) {
    return cursor;
  }
  if (typeof cursor === "string") {
    const asNumber = Number.parseFloat(cursor);
    return Number.isFinite(asNumber) ? asNumber : null;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runProcess(
  command: string,
  options: {
    cwd: string;
    timeoutSeconds?: number;
    inherit: boolean;
    interruptControl?: LoopInterruptControl;
  }
): Promise<ProcessResult> {
  if (options.interruptControl?.interrupted) {
    return {
      exitCode: 130,
      stdout: "",
      stderr: "",
      timedOut: false,
      durationMs: 0
    };
  }

  const startedAt = Date.now();
  const timeoutMs = options.timeoutSeconds ? options.timeoutSeconds * 1000 : undefined;

  return new Promise((resolve) => {
    const child = spawn("sh", ["-lc", command], {
      cwd: options.cwd,
      stdio: options.inherit ? "inherit" : "pipe"
    });
    if (options.interruptControl) {
      options.interruptControl.activeChild = child;
      if (options.interruptControl.interrupted) {
        child.kill("SIGTERM");
      }
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    if (!options.inherit) {
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
    }

    let timer: NodeJS.Timeout | undefined;
    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);
    }

    child.on("error", () => {
      if (timer) {
        clearTimeout(timer);
      }
      resolve({
        exitCode: 1,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt
      });
    });

    child.on("exit", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (options.interruptControl?.activeChild === child) {
        options.interruptControl.activeChild = null;
      }
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt
      });
    });
  });
}

async function isBinaryAvailable(binary: string): Promise<boolean> {
  const result = await runProcess(`command -v ${binary} >/dev/null 2>&1`, {
    cwd: process.cwd(),
    inherit: false
  });
  return result.exitCode === 0;
}

function buildInvocation(provider: ProviderName, model: string, prompt: string): Invocation {
  if (provider === "codex") {
    return {
      binary: "codex",
      args: ["exec", "-m", model, "--skip-git-repo-check", prompt],
      display: `codex exec -m ${model} --skip-git-repo-check "<prompt>"`
    };
  }
  if (provider === "claude") {
    return {
      binary: "claude",
      args: ["--print", "--model", model, prompt],
      display: `claude --print --model ${model} "<prompt>"`
    };
  }
  if (provider === "gemini") {
    return {
      binary: "gemini",
      args: ["--model", model, "--prompt", prompt],
      display: `gemini --model ${model} --prompt "<prompt>"`
    };
  }
  return {
    binary: "ollama",
    args: ["run", model, prompt],
    display: `ollama run ${model} "<prompt>"`
  };
}

async function runModelRole(
  role: "worker" | "manager",
  provider: ProviderName,
  model: string,
  prompt: string,
  cwd: string,
  options?: { captureOutput?: boolean; interruptControl?: LoopInterruptControl }
): Promise<{ exitCode: number; output: string }> {
  const invocation = buildInvocation(provider, model, prompt);
  const available = await isBinaryAvailable(invocation.binary);
  if (!available) {
    console.log(`${roleLabel(role)} Binary "${invocation.binary}" not found on PATH.`);
    console.log(`${roleLabel(role)} Expected command: ${invocation.display}`);
    return { exitCode: 127, output: "" };
  }

  console.log(`${roleLabel(role)} Starting ${provider}/${model}`);
  const shouldCapture = options?.captureOutput === true;
  const result = await new Promise<{ exitCode: number; output: string }>((resolve) => {
    const child = spawn(invocation.binary, invocation.args, {
      cwd,
      stdio: shouldCapture ? "pipe" : "inherit"
    });
    if (options?.interruptControl) {
      options.interruptControl.activeChild = child;
      if (options.interruptControl.interrupted) {
        child.kill("SIGTERM");
      }
    }

    let output = "";
    if (shouldCapture) {
      child.stdout?.on("data", (chunk) => {
        const text = String(chunk);
        output += text;
        process.stdout.write(text);
      });
      child.stderr?.on("data", (chunk) => {
        const text = String(chunk);
        output += text;
        process.stderr.write(text);
      });
    }

    child.on("error", () => resolve({ exitCode: 1, output }));
    child.on("exit", (code) => {
      if (options?.interruptControl?.activeChild === child) {
        options.interruptControl.activeChild = null;
      }
      resolve({ exitCode: code ?? 1, output });
    });
  });

  if (result.exitCode === 0) {
    console.log(`${roleLabel(role)} Finished successfully.`);
  } else {
    console.log(`${roleLabel(role)} Exited with code ${result.exitCode}.`);
  }
  return result;
}

async function runGit(command: string, cwd: string): Promise<ProcessResult> {
  return runProcess(`git ${command}`, { cwd, inherit: false });
}

async function mustRunGit(command: string, cwd: string): Promise<string> {
  const result = await runGit(command, cwd);
  if (result.exitCode !== 0) {
    const detail = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    throw new Error(`git ${command} failed.\n${detail}`);
  }
  return result.stdout.trim();
}

function resultsToTsvLine(result: RoundResult): string {
  const fields = [
    String(result.round),
    result.candidateCommit ?? "",
    String(result.workerExitCode),
    result.evalExitCode === null ? "" : String(result.evalExitCode),
    result.metric === null ? "" : String(result.metric),
    result.decision,
    result.reason.replace(/\s+/g, " ").trim()
  ];
  return `${fields.join("\t")}\n`;
}

function shouldKeepCandidate(
  metric: number,
  bestMetric: number | null,
  optimize: OptimizeDirection,
  keepThreshold: number
): boolean {
  if (bestMetric === null) {
    return true;
  }

  const delta = optimize === "max" ? metric - bestMetric : bestMetric - metric;
  return delta > keepThreshold;
}

function extractInsightAndHypothesis(
  managerOutput: string | null,
  roundResult: RoundResult
): { insight: string; hypothesis: string } {
  if (managerOutput && managerOutput.trim().length > 0) {
    const insightMatch = managerOutput.match(/insight\s*:\s*(.+)/i);
    const hypothesisMatch = managerOutput.match(/hypothesis\s*:\s*(.+)/i);
    return {
      insight:
        insightMatch?.[1]?.trim() ??
        `Round ${roundResult.round} ${roundResult.decision}: ${roundResult.reason}`,
      hypothesis:
        hypothesisMatch?.[1]?.trim() ??
        `Try a different implementation strategy focused on metric improvement.`
    };
  }
  return {
    insight: `Round ${roundResult.round} ${roundResult.decision}: ${roundResult.reason}`,
    hypothesis: `Focus next changes on improving metric while staying in allowed edit scope.`
  };
}

function isSwarmBestBetter(
  swarmBest: SwarmBestRecord | null,
  localBest: number | null,
  optimize: OptimizeDirection
): boolean {
  if (!swarmBest) {
    return false;
  }
  if (localBest === null) {
    return true;
  }
  if (optimize === "max") {
    return swarmBest.metric > localBest;
  }
  return swarmBest.metric < localBest;
}

async function tryApplySwarmBestPatch(
  swarmBest: SwarmBestRecord,
  workspacePath: string,
  sessionDir: string,
  round: number
): Promise<{ applied: boolean; reason: string }> {
  if (!swarmBest.patch || swarmBest.patch.trim().length === 0) {
    return { applied: false, reason: "no patch artifact on swarm best record" };
  }

  const patchPath = path.join(sessionDir, `swarm-best-round-${round}.patch`);
  await writeFile(patchPath, swarmBest.patch, "utf8");
  const applyResult = await runProcess(`git apply --3way "${patchPath}"`, {
    cwd: workspacePath,
    inherit: false
  });
  if (applyResult.exitCode !== 0) {
    await mustRunGit("reset --hard", workspacePath);
    await mustRunGit("clean -fd", workspacePath);
    return { applied: false, reason: "patch apply failed" };
  }

  const status = await mustRunGit("status --porcelain", workspacePath);
  if (status.trim().length === 0) {
    return { applied: false, reason: "patch produced no changes" };
  }

  await mustRunGit("add -A", workspacePath);
  const commitAttempt = await runGit(
    `commit -m "bandmaster loop: sync swarm best from ${swarmBest.agentId}"`,
    workspacePath
  );
  if (commitAttempt.exitCode !== 0) {
    await mustRunGit("reset --hard", workspacePath);
    await mustRunGit("clean -fd", workspacePath);
    return { applied: false, reason: "failed to commit synced patch" };
  }

  return { applied: true, reason: "applied and committed swarm best patch" };
}

function buildWorkerPrompt(
  objective: string,
  round: number,
  maxRounds: number,
  editScope: string[],
  bestMetric: number | null,
  optimize: OptimizeDirection
): string {
  const bestLine =
    bestMetric === null
      ? "No accepted metric yet."
      : `Best metric so far: ${bestMetric} (${optimize === "max" ? "higher is better" : "lower is better"}).`;

  return [
    `You are the worker for Bandmaster loop round ${round}/${maxRounds}.`,
    `Objective: ${objective}`,
    bestLine,
    "",
    "Constraints:",
    `- Edit only files matching: ${editScope.join(", ")}`,
    "- Make focused, testable progress aimed at improving the evaluation metric.",
    "- Keep changes coherent in one candidate iteration.",
    "",
    "When done, stop and return control."
  ].join("\n");
}

function buildManagerPrompt(
  objective: string,
  round: number,
  metric: number | null,
  decision: "keep" | "discard" | "skip",
  reason: string
): string {
  return [
    `You are the manager after loop round ${round}.`,
    `Objective: ${objective}`,
    `Round outcome: ${decision}.`,
    `Metric: ${metric === null ? "none" : String(metric)}.`,
    `Reason: ${reason}`,
    "",
    "Give concise direction for the next worker round in 5 bullets max."
  ].join("\n");
}

export async function loopCommand(options: LoopCommandOptions): Promise<void> {
  const loaded = await loadProjectConfig({
    configPath: options.config,
    cwd: options.cwd
  });

  const config = loaded.config;
  const loopConfig = config.loop;

  const objective = options.prompt ?? config.project.objective;
  const runCommand = options.runCommand ?? loopConfig?.runCommand;
  const metricPatternRaw = options.metricPattern ?? loopConfig?.metricPattern;
  const metricJsonPath = options.metricJsonPath ?? loopConfig?.metricJsonPath;
  if (!runCommand) {
    throw new Error(
      "Missing run command. Provide --run-command or set [loop].runCommand in config."
    );
  }
  if (!metricPatternRaw && !metricJsonPath) {
    throw new Error(
      "Missing metric extractor. Provide --metric-pattern or --metric-json-path (or set one in config)."
    );
  }

  const optimize = chooseOptimize(options.optimize, loopConfig?.optimize);
  const metricSource = chooseMetricSource(options.metricSource, loopConfig?.metricSource);
  const maxRounds = parsePositiveInt(
    options.maxRounds,
    loopConfig?.maxRounds ?? 20,
    "maxRounds"
  );
  const timeoutSeconds = parsePositiveInt(
    options.timeoutSeconds,
    loopConfig?.timeoutSeconds ?? 1800,
    "timeoutSeconds"
  );
  const keepThreshold = parseNumber(
    options.keepThreshold,
    loopConfig?.keepThreshold ?? 0,
    "keepThreshold"
  );
  const editScope = normalizeEditScope(options.editScope, loopConfig?.editScope ?? ["**/*"]);
  if (editScope.length === 0) {
    throw new Error("editScope must include at least one glob pattern.");
  }

  const workspacePath = path.resolve(loaded.cwd, config.project.workspace);
  const metricPattern = metricPatternRaw ? parseMetricPattern(metricPatternRaw) : null;

  await mustRunGit("rev-parse --is-inside-work-tree", workspacePath);
  const initialStatus = await mustRunGit("status --porcelain", workspacePath);
  if (initialStatus.trim().length > 0) {
    throw new Error(
      "Working tree must be clean before loop mode. Commit, stash, or discard local changes first."
    );
  }

  const initialBranch = await mustRunGit("branch --show-current", workspacePath);
  const createBranch = options.createBranch ?? true;
  const targetBranch = options.branch ?? `bandmaster/${timestampForPath()}`;
  if (createBranch) {
    await mustRunGit(`checkout -b ${targetBranch}`, workspacePath);
    console.log(`${roleLabel("system")} Created branch ${targetBranch}`);
  } else {
    console.log(`${roleLabel("system")} Using current branch ${initialBranch}`);
  }

  const sessionDir = path.resolve(
    workspacePath,
    ".bandmaster",
    "sessions",
    `${timestampForPath()}-loop`
  );
  const sessionId = path.basename(sessionDir);
  await mkdir(sessionDir, { recursive: true });
  const resultsPath = path.join(sessionDir, "results.tsv");
  const eventsPath = path.join(sessionDir, "events.jsonl");

  let swarmBackend: FileSwarmBackend | null = null;
  if (options.swarm ?? config.swarm?.enabled ?? false) {
    try {
      swarmBackend = await createSwarmBackendFromProject(config, workspacePath, {
        enabled: options.swarm,
        root: options.swarmRoot,
        swarmId: options.swarmId,
        agentId: options.agentId
      });
      if (swarmBackend) {
        await swarmBackend.join();
        console.log(
          `${roleLabel("system")} Swarm mode enabled: ${swarmBackend.config.swarmId} (${swarmBackend.config.agentId})`
        );
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`${roleLabel("system")} Swarm unavailable, continuing local-only: ${detail}`);
      swarmBackend = null;
    }
  }

  await writeFile(
    resultsPath,
    "round\tcandidate_commit\tworker_exit\teval_exit\tmetric\tdecision\treason\n",
    "utf8"
  );

  console.log(`${roleLabel("system")} Loop session directory: ${sessionDir}`);
  console.log(`${roleLabel("system")} Evaluation command: ${runCommand}`);
  if (metricPatternRaw) {
    console.log(`${roleLabel("system")} Metric pattern: ${metricPatternRaw}`);
  }
  if (metricJsonPath) {
    console.log(`${roleLabel("system")} Metric JSON path: ${metricJsonPath}`);
  }
  console.log(`${roleLabel("system")} Optimize: ${optimize}`);
  console.log(`${roleLabel("system")} Max rounds: ${maxRounds}`);
  console.log(`${roleLabel("system")} Edit scope: ${editScope.join(", ")}`);
  if (swarmBackend) {
    console.log(
      `${roleLabel("system")} Swarm sync cadence: every ${swarmBackend.config.syncEveryNRounds} rounds`
    );
  }

  let bestMetric: number | null = null;
  let bestCommit: string | null = null;
  let lastHypothesis = "Start with the most promising change that can move the metric.";
  const interruptControl: LoopInterruptControl = {
    interrupted: false,
    signal: null,
    activeChild: null
  };
  const onSigInt = (): void => {
    interruptControl.interrupted = true;
    interruptControl.signal = "SIGINT";
    if (interruptControl.activeChild) {
      interruptControl.activeChild.kill("SIGTERM");
    }
  };
  const onSigTerm = (): void => {
    interruptControl.interrupted = true;
    interruptControl.signal = "SIGTERM";
    if (interruptControl.activeChild) {
      interruptControl.activeChild.kill("SIGTERM");
    }
  };
  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);
  let wasInterrupted = false;

  try {
    for (let round = 1; round <= maxRounds; round += 1) {
      if (interruptControl.interrupted) {
        throw new LoopInterruptedError();
      }
    console.log(`\n${roleLabel("system")} === Round ${round}/${maxRounds} ===`);

    if (
      swarmBackend &&
      round % swarmBackend.config.syncEveryNRounds === 0
    ) {
      try {
        const swarmBest = await swarmBackend.getBest();
        if (isSwarmBestBetter(swarmBest, bestMetric, optimize)) {
          const apply = await tryApplySwarmBestPatch(
            swarmBest as SwarmBestRecord,
            workspacePath,
            sessionDir,
            round
          );
          if (apply.applied && swarmBest) {
            bestMetric = swarmBest.metric;
            bestCommit = await mustRunGit("rev-parse HEAD", workspacePath);
          }
          console.log(
            `${roleLabel("system")} Swarm sync attempt: ${apply.reason}`
          );
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`${roleLabel("system")} Swarm sync failed, continuing: ${detail}`);
      }
    }

    let claimKey: string | null = null;
    let claimId: string | null = null;
    if (swarmBackend) {
      try {
        const claimRaw = `${objective}\n${lastHypothesis}\n${runCommand}\n${editScope.join(",")}`;
        claimKey = normalizeSwarmKey(claimRaw);

        const claimWaitDeadlineMs = Date.now() + 30000;
        while (true) {
          if (interruptControl.interrupted) {
            throw new LoopInterruptedError();
          }
          const claim = await swarmBackend.claimWork({
            key: claimKey,
            description: lastHypothesis,
            round
          });
          if (claim.acquired) {
            claimId = claim.claimId;
            break;
          }

          if (Date.now() >= claimWaitDeadlineMs) {
            console.log(
              `${roleLabel("system")} Claim busy; retrying this round without consuming budget.`
            );
            await sleep(1500);
            round -= 1;
            claimKey = null;
            break;
          }
          await sleep(1000);
        }

        if (!claimKey) {
          continue;
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`${roleLabel("system")} Swarm claim failed, continuing local: ${detail}`);
        claimKey = null;
        claimId = null;
      }
    }

    try {
      const workerPrompt = buildWorkerPrompt(
        objective,
        round,
        maxRounds,
        editScope,
        bestMetric,
        optimize
      );
      const workerExitCode = await runModelRole(
        "worker",
        config.worker.primary.provider,
        config.worker.primary.model,
        workerPrompt,
        workspacePath,
        { interruptControl }
      ).then((result) => result.exitCode);
      if (interruptControl.interrupted) {
        throw new LoopInterruptedError();
      }

    const changedFilesRaw = await mustRunGit("status --porcelain", workspacePath);
    const changedFiles = changedFilesRaw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => line.slice(3).trim());

    let roundResult: RoundResult;
    let candidatePatch = "";
    if (changedFiles.length === 0) {
      roundResult = {
        round,
        candidateCommit: null,
        workerExitCode,
        evalExitCode: null,
        metric: null,
        decision: "skip",
        reason: "worker produced no file changes"
      };
    } else {
      const outOfScope = changedFiles.filter((filePath) => !isPathAllowed(filePath, editScope));
      if (outOfScope.length > 0) {
        await mustRunGit("reset --hard", workspacePath);
        await mustRunGit("clean -fd", workspacePath);
        roundResult = {
          round,
          candidateCommit: null,
          workerExitCode,
          evalExitCode: null,
          metric: null,
          decision: "discard",
          reason: `out-of-scope edits: ${outOfScope.join(", ")}`
        };
      } else {
        await mustRunGit("add -A", workspacePath);
        const commitMessage = `bandmaster loop: round ${round} candidate`;
        const commitAttempt = await runGit(`commit -m "${commitMessage}"`, workspacePath);
        if (commitAttempt.exitCode !== 0) {
          const detail = [commitAttempt.stdout.trim(), commitAttempt.stderr.trim()]
            .filter(Boolean)
            .join("\n");
          throw new Error(`Failed to create candidate commit in round ${round}.\n${detail}`);
        }

        const candidateCommit = await mustRunGit("rev-parse HEAD", workspacePath);
        const patchResult = await runGit(`show --format= ${candidateCommit}`, workspacePath);
        candidatePatch = patchResult.exitCode === 0 ? patchResult.stdout : "";
        const evalResult = await runProcess(runCommand, {
          cwd: workspacePath,
          timeoutSeconds,
          inherit: false,
          interruptControl
        });
        if (interruptControl.interrupted) {
          throw new LoopInterruptedError();
        }

        const metricText =
          metricSource === "stdout"
            ? evalResult.stdout
            : metricSource === "stderr"
              ? evalResult.stderr
              : `${evalResult.stdout}\n${evalResult.stderr}`;
        const metric =
          metricJsonPath
            ? parseMetricFromJsonPath(metricText, metricJsonPath)
            : metricPattern
              ? parseMetricFromOutput(metricPattern, metricText)
              : null;

        if (evalResult.exitCode !== 0) {
          await mustRunGit("reset --hard HEAD~1", workspacePath);
          await mustRunGit("clean -fd", workspacePath);
          roundResult = {
            round,
            candidateCommit,
            workerExitCode,
            evalExitCode: evalResult.exitCode,
            metric: null,
            decision: "discard",
            reason: evalResult.timedOut
              ? "evaluation command timed out"
              : "evaluation command failed"
          };
        } else if (metric === null) {
          await mustRunGit("reset --hard HEAD~1", workspacePath);
          await mustRunGit("clean -fd", workspacePath);
          roundResult = {
            round,
            candidateCommit,
            workerExitCode,
            evalExitCode: evalResult.exitCode,
            metric: null,
            decision: "discard",
            reason: "metric pattern did not match evaluation output"
          };
        } else if (shouldKeepCandidate(metric, bestMetric, optimize, keepThreshold)) {
          bestMetric = metric;
          bestCommit = candidateCommit;
          roundResult = {
            round,
            candidateCommit,
            workerExitCode,
            evalExitCode: evalResult.exitCode,
            metric,
            decision: "keep",
            reason: "metric improved enough to keep candidate"
          };

          if (swarmBackend) {
            try {
              const update = await swarmBackend.tryUpdateBest({
                metric,
                optimize,
                sessionId,
                round,
                commit: candidateCommit,
                patch: candidatePatch,
                reason: roundResult.reason
              });
              if (!update.updated) {
                console.log(
                  `${roleLabel("system")} Swarm best not updated: ${update.reason}`
                );
              }
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              console.warn(`${roleLabel("system")} Swarm best update failed: ${detail}`);
            }
          }
        } else {
          await mustRunGit("reset --hard HEAD~1", workspacePath);
          await mustRunGit("clean -fd", workspacePath);
          roundResult = {
            round,
            candidateCommit,
            workerExitCode,
            evalExitCode: evalResult.exitCode,
            metric,
            decision: "discard",
            reason: "metric did not improve enough"
          };
        }
      }
    }

      const metricLabel = roundResult.metric === null ? "n/a" : String(roundResult.metric);
      console.log(
        `${roleLabel("system")} Round ${round} => ${roundResult.decision.toUpperCase()} | metric=${metricLabel} | ${roundResult.reason}`
      );

      let managerOutput: string | null = null;
      if (config.pm.userProxy.enabled) {
        const managerPrompt = buildManagerPrompt(
          objective,
          round,
          roundResult.metric,
          roundResult.decision,
          `${roundResult.reason}\n\nReturn two explicit lines:\nINSIGHT: <what we learned>\nHYPOTHESIS: <what to try next>`
        );
        const managerResult = await runModelRole(
          "manager",
          config.pm.primary.provider,
          config.pm.primary.model,
          managerPrompt,
          workspacePath,
          { captureOutput: true, interruptControl }
        );
        managerOutput = managerResult.output;
        if (interruptControl.interrupted) {
          throw new LoopInterruptedError();
        }
      }

      const extracted = extractInsightAndHypothesis(managerOutput, roundResult);
      roundResult.insight = extracted.insight;
      roundResult.hypothesis = extracted.hypothesis;
      roundResult.optimize = optimize;
      lastHypothesis = extracted.hypothesis;

      await writeFile(resultsPath, resultsToTsvLine(roundResult), {
        encoding: "utf8",
        flag: "a"
      });
      await writeFile(eventsPath, `${JSON.stringify(roundResult)}\n`, {
        encoding: "utf8",
        flag: "a"
      });

      if (swarmBackend) {
        try {
          await swarmBackend.publishRound({
            sessionId,
            round,
            metric: roundResult.metric,
            decision: roundResult.decision,
            reason: roundResult.reason,
            candidateCommit: roundResult.candidateCommit,
            optimize,
            patch: candidatePatch.length > 0 ? candidatePatch : undefined,
            workerExitCode: roundResult.workerExitCode,
            evalExitCode: roundResult.evalExitCode
          });
          await swarmBackend.publishInsight({
            sessionId,
            round,
            insight: extracted.insight,
            hypothesis: extracted.hypothesis
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          console.warn(`${roleLabel("system")} Swarm publish failed, continuing: ${detail}`);
        }
      }
    } finally {
      if (swarmBackend && claimKey) {
        try {
          await swarmBackend.releaseWork(claimKey, claimId);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          console.warn(`${roleLabel("system")} Swarm claim release failed: ${detail}`);
        }
      }
    }
  }
  } catch (error) {
    if (!(error instanceof LoopInterruptedError)) {
      throw error;
    }
    wasInterrupted = true;
    try {
      await mustRunGit("reset --hard", workspacePath);
      await mustRunGit("clean -fd", workspacePath);
    } catch {
      // Best-effort cleanup on interrupt.
    }
    await writeFile(
      path.join(sessionDir, "summary.json"),
      `${JSON.stringify(
        {
          status: "interrupted",
          signal: interruptControl.signal,
          bestMetric,
          bestCommit,
          sessionId,
          ts: new Date().toISOString()
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    console.log(`\n${roleLabel("system")} Loop interrupted immediately by ${interruptControl.signal}.`);
  } finally {
    process.removeListener("SIGINT", onSigInt);
    process.removeListener("SIGTERM", onSigTerm);
  }

  if (wasInterrupted) {
    console.log(`\n${roleLabel("system")} Loop stopped.`);
  } else {
    console.log(`\n${roleLabel("system")} Loop completed.`);
  }
  console.log(
    `${roleLabel("system")} Best metric: ${bestMetric === null ? "none" : String(bestMetric)}`
  );
  console.log(`${roleLabel("system")} Best commit: ${bestCommit ?? "none"}`);
  console.log(`${roleLabel("system")} Results: ${resultsPath}`);
  console.log(`${roleLabel("system")} Events: ${eventsPath}`);
}

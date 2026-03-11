import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadProjectConfig } from "../config/index.js";
import type { ProjectConfig, ProviderName } from "../config/index.js";

type MetricSource = "stdout" | "stderr" | "combined";
type OptimizeDirection = "max" | "min";
type Role = "worker" | "manager" | "system";

export interface LoopCommandOptions {
  config?: string;
  cwd?: string;
  prompt?: string;
  runCommand?: string;
  metricPattern?: string;
  metricSource?: MetricSource;
  optimize?: OptimizeDirection;
  keepThreshold?: number;
  maxRounds?: number;
  timeoutSeconds?: number;
  editScope?: string;
  branch?: string;
  createBranch?: boolean;
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

interface RoundResult {
  round: number;
  candidateCommit: string | null;
  workerExitCode: number;
  evalExitCode: number | null;
  metric: number | null;
  decision: "keep" | "discard" | "skip";
  reason: string;
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

function parseMetricPattern(input: string): RegExp {
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

function parseMetricFromOutput(pattern: RegExp, text: string): number | null {
  const match = pattern.exec(text);
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

async function runProcess(
  command: string,
  options: { cwd: string; timeoutSeconds?: number; inherit: boolean }
): Promise<ProcessResult> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutSeconds ? options.timeoutSeconds * 1000 : undefined;

  return new Promise((resolve) => {
    const child = spawn("sh", ["-lc", command], {
      cwd: options.cwd,
      stdio: options.inherit ? "inherit" : "pipe"
    });

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
  cwd: string
): Promise<number> {
  const invocation = buildInvocation(provider, model, prompt);
  const available = await isBinaryAvailable(invocation.binary);
  if (!available) {
    console.log(`${roleLabel(role)} Binary "${invocation.binary}" not found on PATH.`);
    console.log(`${roleLabel(role)} Expected command: ${invocation.display}`);
    return 127;
  }

  console.log(`${roleLabel(role)} Starting ${provider}/${model}`);
  const result = await new Promise<number>((resolve) => {
    const child = spawn(invocation.binary, invocation.args, {
      cwd,
      stdio: "inherit"
    });
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 1));
  });

  if (result === 0) {
    console.log(`${roleLabel(role)} Finished successfully.`);
  } else {
    console.log(`${roleLabel(role)} Exited with code ${result}.`);
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
  if (!runCommand) {
    throw new Error(
      "Missing run command. Provide --run-command or set [loop].runCommand in config."
    );
  }
  if (!metricPatternRaw) {
    throw new Error(
      "Missing metric pattern. Provide --metric-pattern or set [loop].metricPattern in config."
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
  const metricPattern = parseMetricPattern(metricPatternRaw);

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
  await mkdir(sessionDir, { recursive: true });
  const resultsPath = path.join(sessionDir, "results.tsv");
  const eventsPath = path.join(sessionDir, "events.jsonl");

  await writeFile(
    resultsPath,
    "round\tcandidate_commit\tworker_exit\teval_exit\tmetric\tdecision\treason\n",
    "utf8"
  );

  console.log(`${roleLabel("system")} Loop session directory: ${sessionDir}`);
  console.log(`${roleLabel("system")} Evaluation command: ${runCommand}`);
  console.log(`${roleLabel("system")} Metric pattern: ${metricPatternRaw}`);
  console.log(`${roleLabel("system")} Optimize: ${optimize}`);
  console.log(`${roleLabel("system")} Max rounds: ${maxRounds}`);
  console.log(`${roleLabel("system")} Edit scope: ${editScope.join(", ")}`);

  let bestMetric: number | null = null;
  let bestCommit: string | null = null;

  for (let round = 1; round <= maxRounds; round += 1) {
    console.log(`\n${roleLabel("system")} === Round ${round}/${maxRounds} ===`);

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
      workspacePath
    );

    const changedFilesRaw = await mustRunGit("status --porcelain", workspacePath);
    const changedFiles = changedFilesRaw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => line.slice(3).trim());

    let roundResult: RoundResult;
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
        const evalResult = await runProcess(runCommand, {
          cwd: workspacePath,
          timeoutSeconds,
          inherit: false
        });

        const metricText =
          metricSource === "stdout"
            ? evalResult.stdout
            : metricSource === "stderr"
              ? evalResult.stderr
              : `${evalResult.stdout}\n${evalResult.stderr}`;
        const metric = parseMetricFromOutput(metricPattern, metricText);

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

    await writeFile(resultsPath, resultsToTsvLine(roundResult), { encoding: "utf8", flag: "a" });
    await writeFile(eventsPath, `${JSON.stringify(roundResult)}\n`, {
      encoding: "utf8",
      flag: "a"
    });

    const metricLabel = roundResult.metric === null ? "n/a" : String(roundResult.metric);
    console.log(
      `${roleLabel("system")} Round ${round} => ${roundResult.decision.toUpperCase()} | metric=${metricLabel} | ${roundResult.reason}`
    );

    if (config.pm.userProxy.enabled) {
      const managerPrompt = buildManagerPrompt(
        objective,
        round,
        roundResult.metric,
        roundResult.decision,
        roundResult.reason
      );
      await runModelRole(
        "manager",
        config.pm.primary.provider,
        config.pm.primary.model,
        managerPrompt,
        workspacePath
      );
    }
  }

  console.log(`\n${roleLabel("system")} Loop completed.`);
  console.log(
    `${roleLabel("system")} Best metric: ${bestMetric === null ? "none" : String(bestMetric)}`
  );
  console.log(`${roleLabel("system")} Best commit: ${bestCommit ?? "none"}`);
  console.log(`${roleLabel("system")} Results: ${resultsPath}`);
  console.log(`${roleLabel("system")} Events: ${eventsPath}`);
}

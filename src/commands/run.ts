import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { loadProjectConfig } from "../config/index.js";
import type { ProjectConfig, ProviderName } from "../config/index.js";

export interface RunCommandOptions {
  config?: string;
  cwd?: string;
}

export interface QuickRunCommandOptions {
  config: ProjectConfig;
  prompt: string;
  mode: "rounds" | "hours";
  value: number;
}

interface Invocation {
  binary: string;
  args: string[];
  display: string;
}

type Role = "worker" | "manager" | "system";

async function docExists(absolutePath: string): Promise<boolean> {
  try {
    await access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

function formatConnectionModeFromConfig(config: ProjectConfig, provider: string): string {
  const auth = config.providers[provider]?.auth;
  if (!auth) {
    return "local";
  }
  if (auth.mode === "api") {
    return `API (${auth.apiKeyEnv ?? "missing-env"})`;
  }
  return `Subscription (${auth.subscriptionCommand ?? "missing-command"})`;
}

async function isBinaryAvailable(binary: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-lc", `command -v ${binary} >/dev/null 2>&1`], {
      stdio: "ignore"
    });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

async function runInvocation(invocation: Invocation): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(invocation.binary, invocation.args, {
      stdio: "inherit"
    });
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 1));
  });
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

function buildInvocation(
  provider: ProviderName,
  model: string,
  prompt: string
): Invocation {
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

function buildWorkerRoundPrompt(basePrompt: string, round: number): string {
  return [
    `Round ${round} worker objective:`,
    basePrompt,
    "",
    "Continue implementation from current project state."
  ].join("\n");
}

function buildManagerPrompt(
  basePrompt: string,
  round: number,
  workerExitCode: number
): string {
  return [
    `Manager checkpoint after worker round ${round}.`,
    `Worker exit code: ${workerExitCode}.`,
    `Objective: ${basePrompt}`,
    "",
    "Give concise direction for the next worker round."
  ].join("\n");
}

async function runRole(
  role: "worker" | "manager",
  provider: ProviderName,
  model: string,
  prompt: string
): Promise<number> {
  const invocation = buildInvocation(provider, model, prompt);
  const available = await isBinaryAvailable(invocation.binary);
  if (!available) {
    console.log(`${roleLabel(role)} Binary "${invocation.binary}" not found on PATH.`);
    console.log(`${roleLabel(role)} Expected command: ${invocation.display}`);
    return 127;
  }

  console.log(`${roleLabel(role)} Starting ${provider}/${model}`);
  const exitCode = await runInvocation(invocation);
  if (exitCode === 0) {
    console.log(`${roleLabel(role)} Finished successfully.`);
  } else {
    console.log(`${roleLabel(role)} Exited with code ${exitCode}.`);
  }
  return exitCode;
}

export async function runCommand(options: RunCommandOptions): Promise<void> {
  const loaded = await loadProjectConfig({
    configPath: options.config,
    cwd: options.cwd
  });

  const workspacePath = path.resolve(loaded.cwd, loaded.config.project.workspace);
  const entryDocPaths = loaded.config.project.entryDocs.map((doc) =>
    path.resolve(workspacePath, doc)
  );

  const docChecks = await Promise.all(
    entryDocPaths.map(async (absolutePath) => ({
      absolutePath,
      exists: await docExists(absolutePath)
    }))
  );

  const missingDocs = docChecks.filter((doc) => !doc.exists);

  console.log(`${roleLabel("system")} Run configuration is valid.`);
  console.log(`${roleLabel("system")} Config: ${loaded.configPath}`);
  console.log(`${roleLabel("system")} Project: ${loaded.config.project.name}`);
  console.log(`${roleLabel("system")} Workspace: ${workspacePath}`);
  console.log(
    `${roleLabel("worker")} Model: ${loaded.config.worker.primary.provider}/${loaded.config.worker.primary.model} [${formatConnectionModeFromConfig(loaded.config, loaded.config.worker.primary.provider)}]`
  );
  console.log(
    `${roleLabel("manager")} Model: ${loaded.config.pm.primary.provider}/${loaded.config.pm.primary.model} [${formatConnectionModeFromConfig(loaded.config, loaded.config.pm.primary.provider)}]`
  );
  console.log(`${roleLabel("system")} Policy: ${loaded.config.policy.mode}`);
  console.log(
    `${roleLabel("system")} Session budget: ${loaded.config.budget.maxMinutes}m, ${loaded.config.budget.maxTokens} tokens, ${loaded.config.budget.maxTurns} turns`
  );
  console.log(
    `${roleLabel("system")} Cycle budget: ${loaded.config.budget.cycle.maxTokens} tokens, ${loaded.config.budget.cycle.maxTurns} turns`
  );
  console.log(`${roleLabel("system")} Stop mode: ${loaded.config.budget.stopMode}`);

  if (missingDocs.length > 0) {
    console.warn(`${roleLabel("system")} Warning: missing entry docs:`);
    for (const doc of missingDocs) {
      console.warn(`${roleLabel("system")} - ${doc.absolutePath}`);
    }
  } else {
    console.log(`${roleLabel("system")} Entry docs: all configured files are present.`);
  }
}

export async function runQuickCommand(options: QuickRunCommandOptions): Promise<void> {
  const sessionEndMs =
    options.mode === "hours" ? Date.now() + options.value * 60 * 60 * 1000 : Number.POSITIVE_INFINITY;
  const maxRounds =
    options.mode === "rounds" ? options.value : Number.POSITIVE_INFINITY;

  console.log(`${roleLabel("system")} Quick run starting.`);
  console.log(`${roleLabel("worker")} Prompt: ${options.prompt}`);
  console.log(
    `${roleLabel("worker")} Model: ${options.config.worker.primary.provider}/${options.config.worker.primary.model} [${formatConnectionModeFromConfig(options.config, options.config.worker.primary.provider)}]`
  );
  console.log(
    `${roleLabel("manager")} Model: ${options.config.pm.primary.provider}/${options.config.pm.primary.model} [${formatConnectionModeFromConfig(options.config, options.config.pm.primary.provider)}]`
  );
  console.log(`${roleLabel("system")} Policy: ${options.config.policy.mode}`);
  if (options.mode === "hours") {
    console.log(
      `${roleLabel("system")} Quick budget mode: hours (${options.value}h, enforced)`
    );
    console.log(`${roleLabel("system")} Enforced round cap: none`);
  } else {
    console.log(`${roleLabel("system")} Quick budget mode: rounds (${options.value} rounds, enforced)`);
    console.log(`${roleLabel("system")} Enforced time cap: none`);
  }
  console.log(
    `${roleLabel("system")} Advisory settings budget (not enforced in Quick Run): ${options.config.budget.maxMinutes}m, ${options.config.budget.maxTokens} tokens, ${options.config.budget.maxTurns} turns`
  );
  console.log(
    `${roleLabel("system")} Advisory cycle budget (not enforced in Quick Run): ${options.config.budget.cycle.maxTokens} tokens, ${options.config.budget.cycle.maxTurns} turns`
  );
  console.log(`${roleLabel("system")} Stop mode setting: ${options.config.budget.stopMode} (advisory in Quick Run)`);

  let round = 1;
  while (round <= maxRounds && Date.now() < sessionEndMs) {
    console.log(`\n${roleLabel("worker")} Round ${round}`);
    const workerPrompt = buildWorkerRoundPrompt(options.prompt, round);
    const workerExit = await runRole(
      "worker",
      options.config.worker.primary.provider,
      options.config.worker.primary.model,
      workerPrompt
    );

    if (options.config.pm.userProxy.enabled && Date.now() < sessionEndMs && round < maxRounds) {
      console.log(`\n${roleLabel("manager")} Round ${round}`);
      const managerPrompt = buildManagerPrompt(options.prompt, round, workerExit);
      await runRole(
        "manager",
        options.config.pm.primary.provider,
        options.config.pm.primary.model,
        managerPrompt
      );
    } else if (!options.config.pm.userProxy.enabled) {
      console.log(`${roleLabel("manager")} Skipped (userProxy disabled).`);
    }

    round += 1;
  }

  console.log(`\n${roleLabel("system")} Quick run finished.`);
}

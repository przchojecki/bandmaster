import { access } from "node:fs/promises";
import path from "node:path";
import { loadProjectConfig } from "../config/index.js";

export interface RunCommandOptions {
  config?: string;
  cwd?: string;
}

async function docExists(absolutePath: string): Promise<boolean> {
  try {
    await access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

function formatConnectionMode(
  config: Awaited<ReturnType<typeof loadProjectConfig>>["config"],
  provider: string
): string {
  const auth = config.providers[provider]?.auth;
  if (!auth) {
    return "local";
  }
  if (auth.mode === "api") {
    return `API (${auth.apiKeyEnv ?? "missing-env"})`;
  }
  return `Subscription (${auth.subscriptionCommand ?? "missing-command"})`;
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

  console.log("Bandmaster run configuration is valid.");
  console.log(`Config: ${loaded.configPath}`);
  console.log(`Project: ${loaded.config.project.name}`);
  console.log(`Workspace: ${workspacePath}`);
  console.log(
    `Worker: ${loaded.config.worker.primary.provider}/${loaded.config.worker.primary.model} [${formatConnectionMode(loaded.config, loaded.config.worker.primary.provider)}]`
  );
  console.log(
    `PM: ${loaded.config.pm.primary.provider}/${loaded.config.pm.primary.model} [${formatConnectionMode(loaded.config, loaded.config.pm.primary.provider)}]`
  );
  console.log(`Policy: ${loaded.config.policy.mode}`);
  console.log(
    `Session budget: ${loaded.config.budget.maxMinutes}m, ${loaded.config.budget.maxTokens} tokens, ${loaded.config.budget.maxTurns} turns`
  );
  console.log(
    `Cycle budget: ${loaded.config.budget.cycle.maxTokens} tokens, ${loaded.config.budget.cycle.maxTurns} turns`
  );
  console.log(`Stop mode: ${loaded.config.budget.stopMode}`);

  if (missingDocs.length > 0) {
    console.warn("Warning: missing entry docs:");
    for (const doc of missingDocs) {
      console.warn(`- ${doc.absolutePath}`);
    }
  } else {
    console.log("Entry docs: all configured files are present.");
  }
}

#!/usr/bin/env node

import { Command } from "commander";
import { createRequire } from "node:module";
import { historyCommand } from "./commands/history.js";
import { initCommand } from "./commands/init.js";
import { loopCommand } from "./commands/loop.js";
import { releaseCommand } from "./commands/release.js";
import { runCommand } from "./commands/run.js";
import { swarmJoinCommand, swarmStatusCommand } from "./commands/swarm.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: string };
const APP_VERSION = packageJson.version ?? "0.0.0";

const program = new Command();

program
  .name("bandmaster")
  .description("Bandmaster CLI")
  .action(async () => {
    await initCommand({ version: APP_VERSION });
  })
  .version(APP_VERSION);

program
  .command("init")
  .description("Interactive wizard to create or update .bandmaster/project.toml.")
  .option("-c, --config <path>", "Path to project config file")
  .action(async (options: { config?: string }) => {
    await initCommand({
      config: options.config,
      version: APP_VERSION
    });
  });

program
  .command("run")
  .description("Load and validate project configuration for a run session.")
  .option("-c, --config <path>", "Path to project config file")
  .action(async (options: { config?: string }) => {
    await runCommand({
      config: options.config
    });
  });

program
  .command("loop")
  .description("Closed-loop worker execution with metric-based keep/discard decisions.")
  .option("-c, --config <path>", "Path to project config file")
  .option("--prompt <text>", "Override objective for loop prompts")
  .option("--run-command <command>", "Evaluation command to execute each round")
  .option("--metric-pattern <regex>", "Regex for extracting metric from eval output")
  .option("--metric-json-path <path>", "JSON path for metric extraction (e.g. metrics.score)")
  .option(
    "--metric-source <source>",
    "Where to parse metric from: stdout, stderr, combined"
  )
  .option("--optimize <direction>", "Metric direction: max or min")
  .option("--keep-threshold <number>", "Minimum required improvement to keep candidate")
  .option("--max-rounds <number>", "Maximum optimization rounds")
  .option("--timeout-seconds <number>", "Evaluation timeout per round")
  .option("--edit-scope <patterns>", "Comma-separated glob allowlist for editable files")
  .option("--branch <name>", "Branch to create for this loop session")
  .option("--no-create-branch", "Run on current branch instead of creating a session branch")
  .option("--swarm", "Enable collaborative swarm mode")
  .option("--no-swarm", "Disable collaborative swarm mode")
  .option("--swarm-root <path>", "Shared root path for file-based swarm backend")
  .option("--swarm-id <id>", "Swarm namespace id")
  .option("--agent-id <id>", "Override swarm agent id")
  .action(
    async (options: {
      config?: string;
      prompt?: string;
      runCommand?: string;
      metricPattern?: string;
      metricJsonPath?: string;
      metricSource?: "stdout" | "stderr" | "combined";
      optimize?: "max" | "min";
      keepThreshold?: string;
      maxRounds?: string;
      timeoutSeconds?: string;
      editScope?: string;
      branch?: string;
      createBranch?: boolean;
      swarm?: boolean;
      swarmRoot?: string;
      swarmId?: string;
      agentId?: string;
    }) => {
      await loopCommand({
        config: options.config,
        prompt: options.prompt,
        runCommand: options.runCommand,
        metricPattern: options.metricPattern,
        metricJsonPath: options.metricJsonPath,
        metricSource: options.metricSource,
        optimize: options.optimize,
        keepThreshold:
          options.keepThreshold === undefined
            ? undefined
            : Number.parseFloat(options.keepThreshold),
        maxRounds:
          options.maxRounds === undefined
            ? undefined
            : Number.parseInt(options.maxRounds, 10),
        timeoutSeconds:
          options.timeoutSeconds === undefined
            ? undefined
            : Number.parseInt(options.timeoutSeconds, 10),
        editScope: options.editScope,
        branch: options.branch,
        createBranch: options.createBranch,
        swarm: options.swarm,
        swarmRoot: options.swarmRoot,
        swarmId: options.swarmId,
        agentId: options.agentId
      });
    }
  );

program
  .command("history")
  .description("Show loop session history from .bandmaster/sessions.")
  .option("-c, --config <path>", "Path to project config file")
  .option("--session <id>", "Show detailed rounds for one session id")
  .option("--limit <number>", "How many recent sessions to list")
  .action(async (options: { config?: string; session?: string; limit?: string }) => {
    await historyCommand({
      config: options.config,
      session: options.session,
      limit:
        options.limit === undefined ? undefined : Number.parseInt(options.limit, 10)
    });
  });

program
  .command("release")
  .description("Automate version bump, changelog update, commit, tag, and push.")
  .argument("<version>", "Version for npm version (e.g. 0.1.5, patch, minor)")
  .option("--no-push", "Do not push commit/tag to origin")
  .option("--changelog-file <path>", "Changelog path", "CHANGELOG.md")
  .option("--tag-message <text>", "Annotated tag message")
  .action(
    async (
      version: string,
      options: { push?: boolean; changelogFile?: string; tagMessage?: string }
    ) => {
      await releaseCommand({
        version,
        push: options.push,
        changelogFile: options.changelogFile,
        tagMessage: options.tagMessage
      });
    }
  );

const swarmProgram = program
  .command("swarm")
  .description("Collaborative swarm coordination commands.");

swarmProgram
  .command("join")
  .description("Join a swarm and persist local agent identity.")
  .option("-c, --config <path>", "Path to project config file")
  .option("--swarm-root <path>", "Shared root path for file-based swarm backend")
  .option("--swarm-id <id>", "Swarm namespace id")
  .option("--agent-id <id>", "Override swarm agent id")
  .action(
    async (options: {
      config?: string;
      swarmRoot?: string;
      swarmId?: string;
      agentId?: string;
    }) => {
      await swarmJoinCommand({
        config: options.config,
        root: options.swarmRoot,
        swarmId: options.swarmId,
        agentId: options.agentId
      });
    }
  );

swarmProgram
  .command("status")
  .description("Show current swarm status and best-known record.")
  .option("-c, --config <path>", "Path to project config file")
  .option("--swarm-root <path>", "Shared root path for file-based swarm backend")
  .option("--swarm-id <id>", "Swarm namespace id")
  .option("--agent-id <id>", "Override swarm agent id")
  .action(
    async (options: {
      config?: string;
      swarmRoot?: string;
      swarmId?: string;
      agentId?: string;
    }) => {
      await swarmStatusCommand({
        config: options.config,
        root: options.swarmRoot,
        swarmId: options.swarmId,
        agentId: options.agentId
      });
    }
  );

program
  .parseAsync(process.argv)
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });

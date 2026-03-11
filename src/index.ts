#!/usr/bin/env node

import { Command } from "commander";
import { createRequire } from "node:module";
import { historyCommand } from "./commands/history.js";
import { initCommand } from "./commands/init.js";
import { loopCommand } from "./commands/loop.js";
import { runCommand } from "./commands/run.js";

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
  .action(
    async (options: {
      config?: string;
      prompt?: string;
      runCommand?: string;
      metricPattern?: string;
      metricSource?: "stdout" | "stderr" | "combined";
      optimize?: "max" | "min";
      keepThreshold?: string;
      maxRounds?: string;
      timeoutSeconds?: string;
      editScope?: string;
      branch?: string;
      createBranch?: boolean;
    }) => {
      await loopCommand({
        config: options.config,
        prompt: options.prompt,
        runCommand: options.runCommand,
        metricPattern: options.metricPattern,
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
        createBranch: options.createBranch
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
  .parseAsync(process.argv)
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });

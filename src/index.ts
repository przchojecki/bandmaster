#!/usr/bin/env node

import { Command } from "commander";
import { createRequire } from "node:module";
import { initCommand } from "./commands/init.js";
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
  .parseAsync(process.argv)
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });

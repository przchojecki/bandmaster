import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "toml";
import type { ZodIssue } from "zod";
import { ProjectConfigSchema } from "./schema.js";
import type { ProjectConfig } from "./schema.js";

export interface LoadProjectConfigOptions {
  configPath?: string;
  cwd?: string;
}

export interface LoadedProjectConfig {
  config: ProjectConfig;
  configPath: string;
  cwd: string;
}

const DEFAULT_CONFIG_PATH = ".bandmaster/project.toml";

function formatIssues(issues: ZodIssue[]): string {
  return issues
    .map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `- ${field}: ${issue.message}`;
    })
    .join("\n");
}

export async function loadProjectConfig(
  options: LoadProjectConfigOptions = {}
): Promise<LoadedProjectConfig> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = path.resolve(cwd, options.configPath ?? DEFAULT_CONFIG_PATH);

  let rawConfig: string;
  try {
    rawConfig = await readFile(configPath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read config file at ${configPath}: ${detail}`);
  }

  let parsedToml: unknown;
  try {
    parsedToml = parseToml(rawConfig);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid TOML in ${configPath}: ${detail}`);
  }

  const validated = ProjectConfigSchema.safeParse(parsedToml);
  if (!validated.success) {
    throw new Error(
      `Invalid project config (${configPath}).\n${formatIssues(validated.error.issues)}`
    );
  }

  return {
    config: validated.data,
    configPath,
    cwd
  };
}

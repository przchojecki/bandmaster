import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export interface ReleaseCommandOptions {
  version: string;
  cwd?: string;
  push?: boolean;
  changelogFile?: string;
  tagMessage?: string;
}

interface CmdResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

async function runShell(command: string, cwd: string): Promise<CmdResult> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-lc", command], {
      cwd,
      stdio: "pipe"
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", () => resolve({ exitCode: 1, stdout, stderr }));
    child.on("exit", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}

async function mustRun(command: string, cwd: string): Promise<string> {
  const result = await runShell(command, cwd);
  if (result.exitCode !== 0) {
    const detail = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    throw new Error(`Command failed: ${command}\n${detail}`);
  }
  return result.stdout.trim();
}

function updateReadmeVersion(readmeContent: string, newVersion: string): string {
  return readmeContent.replace(/`v\d+\.\d+\.\d+`/, `\`v${newVersion}\``);
}

function buildChangelogEntry(version: string, commits: string[], previousTag: string | null): string {
  const lines = [
    `## v${version} - ${todayIsoDate()}`,
    previousTag ? `Compared to: ${previousTag}` : "Compared to: initial release",
    ""
  ];

  if (commits.length === 0) {
    lines.push("- No code changes listed.");
  } else {
    for (const commit of commits) {
      lines.push(`- ${commit}`);
    }
  }
  return `${lines.join("\n")}\n\n`;
}

export async function releaseCommand(options: ReleaseCommandOptions): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const changelogFile = options.changelogFile ?? "CHANGELOG.md";
  const shouldPush = options.push ?? true;

  const status = await mustRun("git status --porcelain", cwd);
  if (status.length > 0) {
    throw new Error("Working tree must be clean before release.");
  }

  let previousTag: string | null = null;
  {
    const tagResult = await runShell("git describe --tags --abbrev=0", cwd);
    if (tagResult.exitCode === 0) {
      previousTag = tagResult.stdout.trim();
    }
  }

  await mustRun(`npm version ${options.version} --no-git-tag-version`, cwd);
  const nextVersion = await mustRun("node -p \"require('./package.json').version\"", cwd);
  const nextTag = `v${nextVersion}`;

  const readmePath = path.resolve(cwd, "Readme.md");
  const readmeBefore = await readFile(readmePath, "utf8");
  const readmeAfter = updateReadmeVersion(readmeBefore, nextVersion);
  await writeFile(readmePath, readmeAfter, "utf8");

  const commitRange = previousTag ? `${previousTag}..HEAD` : "HEAD";
  const commitLinesRaw = await mustRun(`git log ${commitRange} --pretty=format:%s`, cwd);
  const commits = commitLinesRaw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const changelogPath = path.resolve(cwd, changelogFile);
  let existingChangelog = "";
  try {
    existingChangelog = await readFile(changelogPath, "utf8");
  } catch {
    existingChangelog = "# Changelog\n\n";
  }
  const entry = buildChangelogEntry(nextVersion, commits, previousTag);
  const hasHeader = existingChangelog.startsWith("#");
  const nextChangelog = hasHeader
    ? existingChangelog.replace(/^(#[^\n]*\n\n?)/, `$1${entry}`)
    : `# Changelog\n\n${entry}${existingChangelog}`;
  await writeFile(changelogPath, nextChangelog, "utf8");

  await mustRun(
    `git add package.json package-lock.json Readme.md "${changelogFile}"`,
    cwd
  );
  await mustRun(`git commit -m "release: ${nextTag}"`, cwd);
  await mustRun(
    `git tag -a ${nextTag} -m "${options.tagMessage ?? `Release ${nextTag}`}"`,
    cwd
  );

  if (shouldPush) {
    await mustRun("git push origin main", cwd);
    await mustRun(`git push origin ${nextTag}`, cwd);
  }

  console.log(`[System] Release complete: ${nextTag}`);
  console.log(`[System] Changelog: ${changelogPath}`);
}

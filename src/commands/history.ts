import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { loadProjectConfig } from "../config/index.js";

type Decision = "keep" | "discard" | "skip";
type OptimizeDirection = "max" | "min";

export interface HistoryCommandOptions {
  config?: string;
  cwd?: string;
  session?: string;
  limit?: number;
}

interface RoundRow {
  round: number;
  candidateCommit: string;
  workerExit: number;
  evalExit: number | null;
  metric: number | null;
  decision: Decision;
  reason: string;
}

interface SessionSummary {
  sessionId: string;
  rounds: number;
  keeps: number;
  discards: number;
  skips: number;
  bestMetric: number | null;
  bestRound: number | null;
  bestCommit: string | null;
  optimize: OptimizeDirection;
}

function parseOptionalNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRoundRow(line: string): RoundRow | null {
  const fields = line.split("\t");
  if (fields.length < 7) {
    return null;
  }

  const round = Number.parseInt(fields[0] ?? "", 10);
  const workerExit = Number.parseInt(fields[2] ?? "", 10);
  if (!Number.isInteger(round) || !Number.isInteger(workerExit)) {
    return null;
  }

  const decision = (fields[5] ?? "").trim() as Decision;
  if (decision !== "keep" && decision !== "discard" && decision !== "skip") {
    return null;
  }

  return {
    round,
    candidateCommit: (fields[1] ?? "").trim(),
    workerExit,
    evalExit: parseOptionalNumber(fields[3] ?? ""),
    metric: parseOptionalNumber(fields[4] ?? ""),
    decision,
    reason: (fields[6] ?? "").trim()
  };
}

async function readSessionRows(resultsPath: string): Promise<RoundRow[]> {
  const content = await readFile(resultsPath, "utf8");
  const lines = content
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  if (lines.length <= 1) {
    return [];
  }

  const rows: RoundRow[] = [];
  for (const line of lines.slice(1)) {
    const row = parseRoundRow(line);
    if (row) {
      rows.push(row);
    }
  }
  return rows;
}

async function readSessionOptimize(eventsPath: string): Promise<OptimizeDirection> {
  try {
    const content = await readFile(eventsPath, "utf8");
    const lines = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { optimize?: unknown };
      if (parsed.optimize === "max" || parsed.optimize === "min") {
        return parsed.optimize;
      }
    }
  } catch {
    return "max";
  }
  return "max";
}

export function summarizeSession(
  sessionId: string,
  rows: RoundRow[],
  optimize: OptimizeDirection
): SessionSummary {
  let keeps = 0;
  let discards = 0;
  let skips = 0;
  let bestMetric: number | null = null;
  let bestRound: number | null = null;
  let bestCommit: string | null = null;

  for (const row of rows) {
    if (row.decision === "keep") {
      keeps += 1;
    } else if (row.decision === "discard") {
      discards += 1;
    } else {
      skips += 1;
    }

    const isBetter =
      row.metric !== null &&
      (bestMetric === null ||
        (optimize === "max" ? row.metric > bestMetric : row.metric < bestMetric));
    if (isBetter) {
      bestMetric = row.metric;
      bestRound = row.round;
      bestCommit = row.candidateCommit.length > 0 ? row.candidateCommit : null;
    }
  }

  return {
    sessionId,
    rounds: rows.length,
    keeps,
    discards,
    skips,
    bestMetric,
    bestRound,
    bestCommit,
    optimize
  };
}

function printSessionSummary(summary: SessionSummary): void {
  const bestMetric =
    summary.bestMetric === null
      ? "n/a"
      : `${summary.bestMetric} (round ${summary.bestRound ?? "?"})`;
  const bestCommit = summary.bestCommit ?? "n/a";
  console.log(
    `${summary.sessionId} | optimize=${summary.optimize} rounds=${summary.rounds} keep=${summary.keeps} discard=${summary.discards} skip=${summary.skips} | best=${bestMetric} | commit=${bestCommit}`
  );
}

function printSessionDetails(sessionId: string, rows: RoundRow[]): void {
  console.log(`Session: ${sessionId}`);
  if (rows.length === 0) {
    console.log("No rounds recorded.");
    return;
  }

  console.log("round | decision | metric | eval_exit | worker_exit | commit");
  for (const row of rows) {
    const metric = row.metric === null ? "n/a" : String(row.metric);
    const evalExit = row.evalExit === null ? "n/a" : String(row.evalExit);
    const commit = row.candidateCommit.length > 0 ? row.candidateCommit : "n/a";
    console.log(
      `${row.round} | ${row.decision} | ${metric} | ${evalExit} | ${row.workerExit} | ${commit}`
    );
    console.log(`  reason: ${row.reason}`);
  }
}

export async function historyCommand(options: HistoryCommandOptions): Promise<void> {
  const loaded = await loadProjectConfig({
    configPath: options.config,
    cwd: options.cwd
  });

  const workspacePath = path.resolve(loaded.cwd, loaded.config.project.workspace);
  const sessionsRoot = path.resolve(workspacePath, ".bandmaster", "sessions");

  let entries: string[];
  try {
    entries = await readdir(sessionsRoot);
  } catch {
    console.log(`[System] No sessions directory found at ${sessionsRoot}`);
    return;
  }

  const sessionDirs = entries
    .filter((name) => name.endsWith("-loop"))
    .sort((a, b) => b.localeCompare(a));

  if (sessionDirs.length === 0) {
    console.log("[System] No loop sessions found.");
    return;
  }

  if (options.session) {
    const target = sessionDirs.find((name) => name === options.session);
    if (!target) {
      throw new Error(
        `Session "${options.session}" not found. Use "bandmaster history" to list available sessions.`
      );
    }

    let rows: RoundRow[];
    try {
      rows = await readSessionRows(path.join(sessionsRoot, target, "results.tsv"));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read session "${target}": ${detail}`);
    }
    printSessionDetails(target, rows);
    return;
  }

  const limitValue =
    options.limit === undefined ? 10 : Number.isInteger(options.limit) ? options.limit : NaN;
  if (!Number.isInteger(limitValue) || limitValue <= 0) {
    throw new Error("limit must be a positive integer.");
  }

  console.log(`[System] Showing ${Math.min(limitValue, sessionDirs.length)} most recent sessions`);
  for (const sessionId of sessionDirs.slice(0, limitValue)) {
    try {
      const rows = await readSessionRows(path.join(sessionsRoot, sessionId, "results.tsv"));
      const optimize = await readSessionOptimize(path.join(sessionsRoot, sessionId, "events.jsonl"));
      const summary = summarizeSession(sessionId, rows, optimize);
      printSessionSummary(summary);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[System] Skipping session ${sessionId}: ${detail}`);
    }
  }
}

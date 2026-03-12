import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type SwarmOptimize = "max" | "min";

export interface SwarmConfig {
  enabled: boolean;
  backend: "file";
  root: string;
  swarmId: string;
  agentId: string;
  claimTtlSeconds: number;
  syncEveryNRounds: number;
  maxMetricJump: number;
}

export interface SwarmClaimInput {
  key: string;
  description: string;
  round: number;
  ttlSeconds?: number;
}

export interface SwarmClaimResult {
  acquired: boolean;
  claimId: string | null;
  ownerAgentId: string | null;
  reason: string;
}

export interface SwarmRoundPublishInput {
  sessionId: string;
  round: number;
  metric: number | null;
  decision: "keep" | "discard" | "skip";
  reason: string;
  candidateCommit: string | null;
  optimize: SwarmOptimize;
  patch?: string;
  workerExitCode: number;
  evalExitCode: number | null;
}

export interface SwarmInsightInput {
  sessionId: string;
  round: number;
  insight: string;
  hypothesis: string;
}

interface StoredClaim {
  claimId: string;
  key: string;
  description: string;
  agentId: string;
  createdAt: string;
  expiresAt: string;
  round: number;
}

interface ClaimsStore {
  claims: Record<string, StoredClaim>;
}

export interface SwarmBestRecord {
  metric: number;
  optimize: SwarmOptimize;
  agentId: string;
  sessionId: string;
  round: number;
  commit: string | null;
  patch?: string;
  reason: string;
  updatedAt: string;
  previous?: {
    metric: number;
    updatedAt: string;
    agentId: string;
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function makeAgentId(): string {
  return `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await readFile(targetPath, "utf8");
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(targetPath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(targetPath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFileAtomic(targetPath: string, value: unknown): Promise<void> {
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rm(targetPath, { force: true });
  await writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rm(tempPath, { force: true });
}

function sanitizeClaims(store: ClaimsStore): ClaimsStore {
  const now = Date.now();
  const claims: Record<string, StoredClaim> = {};
  for (const [key, claim] of Object.entries(store.claims)) {
    const expiry = Date.parse(claim.expiresAt);
    if (Number.isFinite(expiry) && expiry > now) {
      claims[key] = claim;
    }
  }
  return { claims };
}

async function withLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  timeoutMs = 7000
): Promise<T> {
  const start = Date.now();
  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for lock: ${lockPath}`);
      }
      await sleep(60);
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

function isBetterMetric(
  nextMetric: number,
  currentMetric: number | null,
  optimize: SwarmOptimize
): boolean {
  if (currentMetric === null) {
    return true;
  }
  if (optimize === "max") {
    return nextMetric > currentMetric;
  }
  return nextMetric < currentMetric;
}

function makeKey(raw: string): string {
  const normalized = raw.trim().toLowerCase().replace(/\s+/g, " ");
  let hash = 5381;
  for (let index = 0; index < normalized.length; index += 1) {
    hash = (hash * 33) ^ normalized.charCodeAt(index);
  }
  return `k${(hash >>> 0).toString(16)}`;
}

export function normalizeSwarmKey(raw: string): string {
  return makeKey(raw);
}

export class FileSwarmBackend {
  private readonly rootPath: string;
  private readonly claimsPath: string;
  private readonly bestPath: string;
  private readonly resultsPath: string;
  private readonly insightsPath: string;
  private readonly agentsPath: string;
  private readonly claimsLockPath: string;
  private readonly bestLockPath: string;
  private readonly agentsLockPath: string;

  public readonly config: SwarmConfig;

  constructor(config: Omit<SwarmConfig, "agentId"> & { agentId?: string }) {
    const agentId = config.agentId?.trim().length ? config.agentId : makeAgentId();
    this.config = {
      ...config,
      agentId
    };

    this.rootPath = path.resolve(config.root, config.swarmId);
    this.claimsPath = path.join(this.rootPath, "claims.json");
    this.bestPath = path.join(this.rootPath, "best.json");
    this.resultsPath = path.join(this.rootPath, "results.jsonl");
    this.insightsPath = path.join(this.rootPath, "insights.jsonl");
    this.agentsPath = path.join(this.rootPath, "agents.json");
    this.claimsLockPath = path.join(this.rootPath, ".claims.lock");
    this.bestLockPath = path.join(this.rootPath, ".best.lock");
    this.agentsLockPath = path.join(this.rootPath, ".agents.lock");
  }

  public getRootPath(): string {
    return this.rootPath;
  }

  public async ensureInitialized(): Promise<void> {
    await mkdir(this.rootPath, { recursive: true });
    if (!(await fileExists(this.claimsPath))) {
      await writeJsonFileAtomic(this.claimsPath, { claims: {} });
    }
    if (!(await fileExists(this.agentsPath))) {
      await writeJsonFileAtomic(this.agentsPath, { agents: {} });
    }
  }

  public async join(): Promise<void> {
    await this.ensureInitialized();
    await withLock(this.agentsLockPath, async () => {
      const store = await readJsonFile<{ agents: Record<string, unknown> }>(this.agentsPath, {
        agents: {}
      });
      store.agents[this.config.agentId] = {
        joinedAt: nowIso(),
        hostname: hostname(),
        pid: process.pid
      };
      await writeJsonFileAtomic(this.agentsPath, store);
    });
  }

  public async claimWork(input: SwarmClaimInput): Promise<SwarmClaimResult> {
    await this.ensureInitialized();
    return withLock(this.claimsLockPath, async () => {
      const storeRaw = await readJsonFile<ClaimsStore>(this.claimsPath, { claims: {} });
      const store = sanitizeClaims(storeRaw);
      const existing = store.claims[input.key];
      if (existing && existing.agentId !== this.config.agentId) {
        await writeJsonFileAtomic(this.claimsPath, store);
        return {
          acquired: false,
          claimId: null,
          ownerAgentId: existing.agentId,
          reason: `active claim by ${existing.agentId}`
        };
      }

      const ttl = input.ttlSeconds ?? this.config.claimTtlSeconds;
      const claimId = `${this.config.agentId}-${Date.now()}`;
      const createdAt = Date.now();
      store.claims[input.key] = {
        claimId,
        key: input.key,
        description: input.description,
        agentId: this.config.agentId,
        createdAt: new Date(createdAt).toISOString(),
        expiresAt: new Date(createdAt + ttl * 1000).toISOString(),
        round: input.round
      };
      await writeJsonFileAtomic(this.claimsPath, store);
      return {
        acquired: true,
        claimId,
        ownerAgentId: this.config.agentId,
        reason: "claimed"
      };
    });
  }

  public async releaseWork(key: string, claimId: string | null): Promise<void> {
    if (!claimId) {
      return;
    }
    await this.ensureInitialized();
    await withLock(this.claimsLockPath, async () => {
      const storeRaw = await readJsonFile<ClaimsStore>(this.claimsPath, { claims: {} });
      const store = sanitizeClaims(storeRaw);
      const claim = store.claims[key];
      if (!claim) {
        await writeJsonFileAtomic(this.claimsPath, store);
        return;
      }
      if (claim.agentId === this.config.agentId && claim.claimId === claimId) {
        delete store.claims[key];
      }
      await writeJsonFileAtomic(this.claimsPath, store);
    });
  }

  public async publishRound(input: SwarmRoundPublishInput): Promise<void> {
    await this.ensureInitialized();
    const record = {
      ts: nowIso(),
      agentId: this.config.agentId,
      ...input
    };
    await appendFile(this.resultsPath, `${JSON.stringify(record)}\n`, "utf8");
  }

  public async publishInsight(input: SwarmInsightInput): Promise<void> {
    await this.ensureInitialized();
    const record = {
      ts: nowIso(),
      agentId: this.config.agentId,
      ...input
    };
    await appendFile(this.insightsPath, `${JSON.stringify(record)}\n`, "utf8");
  }

  public async getBest(): Promise<SwarmBestRecord | null> {
    await this.ensureInitialized();
    return readJsonFile<SwarmBestRecord | null>(this.bestPath, null);
  }

  public async tryUpdateBest(
    candidate: Omit<SwarmBestRecord, "updatedAt" | "previous" | "agentId"> & {
      optimize: SwarmOptimize;
    }
  ): Promise<{ updated: boolean; reason: string; best: SwarmBestRecord | null }> {
    await this.ensureInitialized();
    return withLock(this.bestLockPath, async () => {
      const current = await readJsonFile<SwarmBestRecord | null>(this.bestPath, null);
      if (!isBetterMetric(candidate.metric, current?.metric ?? null, candidate.optimize)) {
        return { updated: false, reason: "not-better-than-current", best: current };
      }

      if (
        current &&
        Number.isFinite(this.config.maxMetricJump) &&
        this.config.maxMetricJump > 0
      ) {
        const jump =
          candidate.optimize === "max"
            ? candidate.metric - current.metric
            : current.metric - candidate.metric;
        if (jump > this.config.maxMetricJump) {
          return { updated: false, reason: "rejected-suspicious-jump", best: current };
        }
      }

      const next: SwarmBestRecord = {
        ...candidate,
        agentId: this.config.agentId,
        updatedAt: nowIso(),
        previous: current
          ? {
              metric: current.metric,
              updatedAt: current.updatedAt,
              agentId: current.agentId
            }
          : undefined
      };
      await writeJsonFileAtomic(this.bestPath, next);
      return { updated: true, reason: "updated", best: next };
    });
  }

  public async getStatus(): Promise<{
    rootPath: string;
    swarmId: string;
    agentId: string;
    activeClaims: number;
    totalResults: number;
    totalInsights: number;
    best: SwarmBestRecord | null;
  }> {
    await this.ensureInitialized();
    const claimsStore = sanitizeClaims(
      await readJsonFile<ClaimsStore>(this.claimsPath, { claims: {} })
    );
    const resultsRaw = await readFile(this.resultsPath, "utf8").catch(() => "");
    const insightsRaw = await readFile(this.insightsPath, "utf8").catch(() => "");
    const best = await this.getBest();

    const totalResults = resultsRaw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0).length;
    const totalInsights = insightsRaw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0).length;

    return {
      rootPath: this.rootPath,
      swarmId: this.config.swarmId,
      agentId: this.config.agentId,
      activeClaims: Object.keys(claimsStore.claims).length,
      totalResults,
      totalInsights,
      best
    };
  }
}

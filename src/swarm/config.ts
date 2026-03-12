import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectConfig } from "../config/index.js";
import { FileSwarmBackend } from "./file-backend.js";

const DEFAULT_AGENT_STATE_PATH = ".bandmaster/swarm-agent.json";

interface AgentState {
  agentId: string;
  swarmId: string;
  root: string;
  updatedAt: string;
}

export interface SwarmOverrides {
  enabled?: boolean;
  root?: string;
  swarmId?: string;
  agentId?: string;
}

async function readAgentState(statePath: string): Promise<AgentState | null> {
  try {
    const raw = await readFile(statePath, "utf8");
    return JSON.parse(raw) as AgentState;
  } catch {
    return null;
  }
}

export async function writeAgentState(
  workspacePath: string,
  state: AgentState
): Promise<void> {
  const statePath = path.resolve(workspacePath, DEFAULT_AGENT_STATE_PATH);
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function createSwarmBackendFromProject(
  config: ProjectConfig,
  workspacePath: string,
  overrides: SwarmOverrides = {}
): Promise<FileSwarmBackend | null> {
  const swarmConfig = config.swarm;
  const statePath = path.resolve(workspacePath, DEFAULT_AGENT_STATE_PATH);
  const state = await readAgentState(statePath);

  const enabled = overrides.enabled ?? swarmConfig?.enabled ?? false;
  if (!enabled) {
    return null;
  }

  const root = path.resolve(
    workspacePath,
    overrides.root ?? swarmConfig?.root ?? state?.root ?? ".bandmaster/swarm"
  );
  const swarmId = overrides.swarmId ?? swarmConfig?.swarmId ?? state?.swarmId ?? "default";
  const agentId = overrides.agentId ?? swarmConfig?.agentId ?? state?.agentId;

  return new FileSwarmBackend({
    enabled: true,
    backend: "file",
    root,
    swarmId,
    agentId,
    claimTtlSeconds: swarmConfig?.claimTtlSeconds ?? 1200,
    syncEveryNRounds: swarmConfig?.syncEveryNRounds ?? 3,
    maxMetricJump: swarmConfig?.maxMetricJump ?? 1000000
  });
}

import path from "node:path";
import { loadProjectConfig } from "../config/index.js";
import {
  createSwarmBackendFromProject,
  writeAgentState
} from "../swarm/config.js";

export interface SwarmJoinCommandOptions {
  config?: string;
  cwd?: string;
  root?: string;
  swarmId?: string;
  agentId?: string;
}

export interface SwarmStatusCommandOptions {
  config?: string;
  cwd?: string;
  root?: string;
  swarmId?: string;
  agentId?: string;
}

export async function swarmJoinCommand(options: SwarmJoinCommandOptions): Promise<void> {
  const loaded = await loadProjectConfig({
    configPath: options.config,
    cwd: options.cwd
  });
  const workspacePath = path.resolve(loaded.cwd, loaded.config.project.workspace);

  const backend = await createSwarmBackendFromProject(loaded.config, workspacePath, {
    enabled: true,
    root: options.root,
    swarmId: options.swarmId,
    agentId: options.agentId
  });
  if (!backend) {
    throw new Error("Failed to initialize swarm backend.");
  }

  await backend.join();
  await writeAgentState(workspacePath, {
    agentId: backend.config.agentId,
    swarmId: backend.config.swarmId,
    root: backend.config.root,
    updatedAt: new Date().toISOString()
  });

  console.log("[System] Joined swarm.");
  console.log(`[System] Agent: ${backend.config.agentId}`);
  console.log(`[System] Swarm ID: ${backend.config.swarmId}`);
  console.log(`[System] Root: ${backend.getRootPath()}`);
}

export async function swarmStatusCommand(options: SwarmStatusCommandOptions): Promise<void> {
  const loaded = await loadProjectConfig({
    configPath: options.config,
    cwd: options.cwd
  });
  const workspacePath = path.resolve(loaded.cwd, loaded.config.project.workspace);

  const backend = await createSwarmBackendFromProject(loaded.config, workspacePath, {
    enabled: true,
    root: options.root,
    swarmId: options.swarmId,
    agentId: options.agentId
  });
  if (!backend) {
    throw new Error("Failed to initialize swarm backend.");
  }

  const status = await backend.getStatus();
  console.log("[System] Swarm status");
  console.log(`[System] Agent: ${status.agentId}`);
  console.log(`[System] Swarm ID: ${status.swarmId}`);
  console.log(`[System] Root: ${status.rootPath}`);
  console.log(`[System] Active claims: ${status.activeClaims}`);
  console.log(`[System] Total results: ${status.totalResults}`);
  console.log(`[System] Total insights: ${status.totalInsights}`);
  if (status.best) {
    console.log(
      `[System] Best: metric=${status.best.metric} optimize=${status.best.optimize} by=${status.best.agentId} at=${status.best.updatedAt}`
    );
  } else {
    console.log("[System] Best: none");
  }
}

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileSwarmBackend } from "../swarm/file-backend.js";

test("swarm backend recovers from stale claim lock and can claim work", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bandmaster-swarm-test-"));
  try {
    const backend = new FileSwarmBackend({
      enabled: true,
      backend: "file",
      root,
      swarmId: "s1",
      claimTtlSeconds: 1200,
      syncEveryNRounds: 3,
      maxMetricJump: 1000000
    });
    await backend.ensureInitialized();

    const lockPath = path.join(backend.getRootPath(), ".claims.lock");
    await mkdir(lockPath, { recursive: true });
    const old = new Date(Date.now() - 120_000);
    await utimes(lockPath, old, old);

    const claim = await backend.claimWork({
      key: "k1",
      description: "d",
      round: 1
    });
    assert.equal(claim.acquired, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("swarm backend rejects suspicious metric jumps", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bandmaster-swarm-test-"));
  try {
    const backend = new FileSwarmBackend({
      enabled: true,
      backend: "file",
      root,
      swarmId: "s2",
      claimTtlSeconds: 1200,
      syncEveryNRounds: 3,
      maxMetricJump: 5
    });
    await backend.ensureInitialized();

    const first = await backend.tryUpdateBest({
      metric: 10,
      optimize: "max",
      sessionId: "sess",
      round: 1,
      commit: "c1",
      reason: "r1"
    });
    assert.equal(first.updated, true);

    const second = await backend.tryUpdateBest({
      metric: 30,
      optimize: "max",
      sessionId: "sess",
      round: 2,
      commit: "c2",
      reason: "r2"
    });
    assert.equal(second.updated, false);
    assert.equal(second.reason, "rejected-suspicious-jump");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

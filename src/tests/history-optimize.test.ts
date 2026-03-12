import test from "node:test";
import assert from "node:assert/strict";
import { summarizeSession } from "../commands/history.js";

test("summarizeSession uses min optimization correctly", () => {
  const rows = [
    {
      round: 1,
      candidateCommit: "a",
      workerExit: 0,
      evalExit: 0,
      metric: 10,
      decision: "keep" as const,
      reason: ""
    },
    {
      round: 2,
      candidateCommit: "b",
      workerExit: 0,
      evalExit: 0,
      metric: 8,
      decision: "keep" as const,
      reason: ""
    },
    {
      round: 3,
      candidateCommit: "c",
      workerExit: 0,
      evalExit: 0,
      metric: 9,
      decision: "discard" as const,
      reason: ""
    }
  ];

  const summary = summarizeSession("s", rows, "min");
  assert.equal(summary.bestMetric, 8);
  assert.equal(summary.bestRound, 2);
  assert.equal(summary.bestCommit, "b");
});

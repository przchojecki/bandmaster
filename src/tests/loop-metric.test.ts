import test from "node:test";
import assert from "node:assert/strict";
import {
  parseMetricFromJsonPath,
  parseMetricFromOutput,
  parseMetricPattern
} from "../commands/loop.js";

test("parseMetricFromOutput ignores global regex state across calls", () => {
  const pattern = parseMetricPattern("/score:\\s*([0-9.]+)/gm");
  const text = "score: 0.42\n";

  const first = parseMetricFromOutput(pattern, text);
  const second = parseMetricFromOutput(pattern, text);

  assert.equal(first, 0.42);
  assert.equal(second, 0.42);
});

test("parseMetricFromJsonPath extracts numeric metric from nested json", () => {
  const jsonText = JSON.stringify({
    metrics: {
      score: "0.91"
    }
  });
  const metric = parseMetricFromJsonPath(jsonText, "metrics.score");
  assert.equal(metric, 0.91);
});

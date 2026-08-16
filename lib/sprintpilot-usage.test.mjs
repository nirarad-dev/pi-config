import assert from "node:assert/strict";
import test from "node:test";
import { aggregateSprintPilotUsage, normalizeClaudeRateLimits } from "./sprintpilot-usage.ts";

test("aggregates recent Pi usage by Claude and Codex provider", () => {
  const recent = new Date("2026-08-12T10:00:00Z").getTime();
  const usage = aggregateSprintPilotUsage([
    `${JSON.stringify({ type: "message", timestamp: "2026-08-12T10:00:00Z", message: { role: "assistant", provider: "anthropic", usage: { totalTokens: 1200 }, timestamp: recent } })}\n`
      + `${JSON.stringify({ type: "message", timestamp: "2026-08-12T10:01:00Z", message: { role: "assistant", provider: "openai-codex", usage: { totalTokens: 3400 }, timestamp: recent + 60_000 } })}\n`
      + `${JSON.stringify({ type: "message", timestamp: "2026-08-01T10:00:00Z", message: { role: "assistant", provider: "anthropic", usage: { totalTokens: 9999 } } })}`,
  ], new Date("2026-08-10T00:00:00Z").getTime());

  assert.equal(usage.claude.tokens, 1200);
  assert.equal(usage.claude.turns, 1);
  assert.equal(usage.codex.tokens, 3400);
  assert.equal(usage.codex.turns, 1);
  assert.equal(usage.codex.updatedAt, "2026-08-12T10:01:00.000Z");
});

test("ignores malformed and non-assistant session lines", () => {
  const usage = aggregateSprintPilotUsage([
    `not json\n${JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message: { role: "user", provider: "anthropic", usage: { totalTokens: 100 } } })}`,
  ], 0);

  assert.deepEqual(usage, { claude: { tokens: 0, turns: 0 }, codex: { tokens: 0, turns: 0 } });
});

test("normalizes Claude five-hour and weekly utilization percentages", () => {
  assert.deepEqual(normalizeClaudeRateLimits({
    five_hour: { utilization: 37.4, resets_at: "2026-08-12T10:00:00Z" },
    seven_day: { utilization: 54, resets_at: "2026-08-13T03:00:00Z" },
  }, "2026-08-12T09:00:00Z"), {
    fiveHour: { usedPercentage: 37.4, resetsAt: "2026-08-12T10:00:00Z" },
    weekly: { usedPercentage: 54, resetsAt: "2026-08-13T03:00:00Z" },
    fetchedAt: "2026-08-12T09:00:00Z",
  });
});

test("accepts status-line percentage fields and clamps invalid ranges", () => {
  assert.deepEqual(normalizeClaudeRateLimits({
    five_hour: { used_percentage: 140 },
    seven_day: { used_percentage: -4 },
  }, "now"), {
    fiveHour: { usedPercentage: 100 },
    weekly: { usedPercentage: 0 },
    fetchedAt: "now",
  });
  assert.equal(normalizeClaudeRateLimits({ five_hour: null }, "now"), undefined);
});

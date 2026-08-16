import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./SprintPilot.tsx", import.meta.url), "utf8");

test("offers manual Jira refresh through the shared sync routine", () => {
  assert.match(source, /onClick=\{\(\) => syncJiraTasks\(\{ announce: true \}\)\}/);
  assert.match(source, /REFRESH JIRA/);
});

test("polls Jira every minute only while the page is visible", () => {
  assert.match(source, /document\.visibilityState === "visible"/);
  assert.match(source, /setInterval\([\s\S]*?syncJiraTasks\(\)[\s\S]*?, 60_000\)/);
});

test("deduplicates overlapping Jira synchronization", () => {
  assert.match(source, /if \(jiraSyncing\.current\) return/);
  assert.match(source, /jiraSyncing\.current = false/);
});

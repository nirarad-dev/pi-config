import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./sprintpilot-commit-metadata.ts", import.meta.url), "utf8");

test("commit message generation uses Jira context and asks for behavioral detail", () => {
  assert.match(source, /Jira details/);
  assert.match(source, /concrete implementation or verification outcome/);
  assert.match(source, /Prefer what changed and why over listing paths or symbols/);
  assert.match(source, /The subject must begin exactly/);
  assert.match(source, /FAST_MODEL_PATTERN/);
  assert.match(source, /getAvailableSnapshot/);
  assert.match(source, /initialState\.messages = \[\]/);
});

test("invalid agent output retains the deterministic snapshot fallback", () => {
  assert.match(source, /parseSprintPilotCommitMessage/);
  assert.match(source, /return fallback/);
});

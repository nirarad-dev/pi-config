import assert from "node:assert/strict";
import test from "node:test";
import { completedStepsForJiraStatus, normalizeCompletedSteps, resolveTestArgs, TEST_PRESETS } from "./sprintpilot-config.ts";

test("exposes the four launch configurations", () => {
  assert.equal(TEST_PRESETS.length, 4);
  assert.deepEqual(TEST_PRESETS.map((preset) => preset.id), [
    "warm-preprod",
    "cold-reset",
    "cold-no-extension",
    "playwright-inspector",
  ]);
});

test("remote provider overrides replace the enabled local provider", () => {
  const args = resolveTestArgs(TEST_PRESETS[0], ["saucelabs"]);
  assert.ok(args.includes("--appium-provider=saucelabs"));
  assert.ok(!args.includes("--appium-provider=local"));
});

test("browserstack debugging activates the matching provider", () => {
  const args = resolveTestArgs(TEST_PRESETS[1], ["browserstack-debug"]);
  assert.ok(args.includes("--appium-provider=browserstack"));
  assert.ok(args.includes("--browserstack-interactive-debugging"));
});

test("conflicting remote providers are rejected", () => {
  assert.throws(() => resolveTestArgs(TEST_PRESETS[0], ["saucelabs", "browserstack"]));
});

test("code review Jira statuses complete planning and development", () => {
  assert.deepEqual(completedStepsForJiraStatus("In CR"), ["Plan", "Develop"]);
  assert.deepEqual(completedStepsForJiraStatus("Code Review"), ["Plan", "Develop"]);
  assert.deepEqual(completedStepsForJiraStatus("Backlog"), []);
});

test("completed workflow steps are deduplicated and kept in workflow order", () => {
  assert.deepEqual(normalizeCompletedSteps(["Develop", "Plan"], ["Plan", "Test", "unknown"]), ["Plan", "Develop", "Test"]);
});

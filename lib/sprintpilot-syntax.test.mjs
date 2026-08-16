import assert from "node:assert/strict";
import test from "node:test";
import { sprintPilotDiffLanguage } from "./sprintpilot-syntax.ts";

test("selects Python syntax for Python source and stub files", () => {
  assert.equal(sprintPilotDiffLanguage("services/policy.py"), "python");
  assert.equal(sprintPilotDiffLanguage("types\\wallet.pyi"), "python");
});

test("supports common review file types and leaves unknown files plain", () => {
  assert.equal(sprintPilotDiffLanguage("components/View.tsx"), "tsx");
  assert.equal(sprintPilotDiffLanguage("config/settings.yaml"), "yaml");
  assert.equal(sprintPilotDiffLanguage("Dockerfile"), "docker");
  assert.equal(sprintPilotDiffLanguage("fixtures/archive.bin"), undefined);
});

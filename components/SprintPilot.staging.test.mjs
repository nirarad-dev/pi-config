import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./SprintPilot.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./SprintPilot.module.css", import.meta.url), "utf8");

test("the client keeps no parallel idea of what is in the commit", () => {
  // Git's index is the selection now; a second source of truth would have to be
  // reconciled with it on every commit.
  assert.doesNotMatch(source, /selectedFiles/);
  assert.doesNotMatch(source, /type="checkbox"[^>]*commit approval/);
});

test("staged and unstaged are derived from the two porcelain status columns", () => {
  assert.match(source, /file\.source\.indexStatus && !" \?"\.includes\(file\.source\.indexStatus\)/);
  assert.match(source, /file\.source\.worktreeStatus && file\.source\.worktreeStatus !== " "/);
});

test("changes and staged are tabs, so a deep path gets the full column width", () => {
  assert.match(source, /role="tablist"/);
  assert.match(source, /stagingTab === "changes"/);
  assert.match(source, /stagingTab === "staged"/);
  assert.match(source, /aria-selected=\{stagingTab === "changes"\}/);
});

test("row actions point the direction they move a file", () => {
  assert.match(source, /action\.kind === "stage" \? "→" : "←"/);
  assert.match(source, /kind: "stage", disabled: !!busy/);
  assert.match(source, /kind: "unstage", disabled: !!busy/);
});

test("the file row leaves the name the flexible column and the action its own", () => {
  // A 28px checkbox column used to lead this row. Left behind, it squeezed the
  // filename into `auto` and handed the arrow the free space.
  assert.match(css, /\.fileRow\{display:grid;grid-template-columns:minmax\(0,1fr\) auto/);
  assert.doesNotMatch(css, /\.fileRow\{display:grid;grid-template-columns:28px/);
});

test("changing the staged set invalidates a drafted message", () => {
  const staging = source.slice(source.indexOf("const runStaging ="), source.indexOf("const gitAction ="));
  assert.match(staging, /updateRuntime\(\{ approvalToken: undefined \}\)/);
  assert.match(staging, /setIgnoredStagePrompt/);
});

test("committing everything clears the awaiting-you signal", () => {
  assert.match(source, /pending\.changed === 0 && \(previous\[key\]\?\.changed \|\| 0\) > 0/);
  assert.match(source, /clearAgentAlert\(key\)/);
});

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

test("the diff paints word-level detail under the highlighted text", () => {
  // The highlighter owns the line's markup, so segment backgrounds go on a
  // character-identical layer beneath it rather than inside it.
  assert.match(source, /function ChangeUnderlay/);
  assert.match(source, /annotateDiffLines\(hunk\.lines\)/);
  assert.match(source, /styles\.codeCell/);
  assert.match(css, /\.changeUnderlay\{position:absolute/);
  assert.match(css, /color:transparent/);
});

test("both layers share one padding box so the two stay aligned", () => {
  // The highlighter's inline padding was moved to the wrapper; leaving it in
  // place would offset every background by 8px.
  assert.match(source, /customStyle=\{\{ margin: 0, padding: 0,/);
  assert.match(css, /\.codeCell\{position:relative;display:block;min-width:0;padding:0 14px 0 8px\}/);
  assert.match(css, /\.changeUnderlay\{[^}]*padding:0 14px 0 8px/);
});

test("word backgrounds are darker than the line they sit on", () => {
  const alpha = (rule) => Number(css.match(rule)[1]);
  assert.ok(alpha(/\.wordAdded\{background:rgba\(46,160,67,\.(\d+)\)/) > alpha(/\.line_added\{background:rgba\(46,160,67,\.(\d+)\)/));
  assert.ok(alpha(/\.wordRemoved\{background:rgba\(218,54,51,\.(\d+)\)/) > alpha(/\.line_removed\{background:rgba\(218,54,51,\.(\d+)\)/));
});

test("a whitespace-only change is muted rather than coloured like a real edit", () => {
  assert.match(source, /line\.whitespaceOnly \? styles\.lineWhitespaceOnly : ""/);
  assert.match(source, /line\.whitespaceOnly \? styles\.wordWhitespace : ""/);
  assert.match(css, /\.lineWhitespaceOnly\.line_added\{background:rgba\(46,160,67,\.05\)\}/);
  assert.match(css, /\.wordWhitespace\{background:rgba\(125,131,140/);
  assert.match(source, /isWhitespaceOnlyHunk/);
});

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

test("the diff derives its add and remove colours from the Cursor Dark palette", () => {
  // The published theme has no diff mapping, so these are its own green and red.
  // The two mid tones are sampled from Cursor itself.
  assert.match(css, /--diff-add-line:#364b3c/);
  assert.match(css, /--diff-add-word:#4c5f52/);
  // Consecutive changed lines must read as one band, not a stack of boxes.
  assert.match(css, /\.codeLine\{min-width:max-content;width:100%\}/);
  assert.match(css, /\.editorCode\{\s*background:#141414/);
  // Line text colour stays untinted so syntax highlighting reads normally.
  assert.doesNotMatch(css, /\.line_added\{background:[^}]*;color:/);
  assert.doesNotMatch(css, /\.line_removed\{background:[^}]*;color:/);
});

test("the syntax palette is Cursor Dark, including the added Python categories", () => {
  assert.match(source, /\{ \.\.\.cursorDarkPrismTheme, \.\.\.sprintPilotDiffTokenStyles \}/);
  assert.doesNotMatch(source, /vscDarkPlus|dracula/);
  const theme = readFileSync(new URL("../lib/sprintpilot-theme.ts", import.meta.url), "utf8");
  // The theme must not set font metrics or a text shadow: the diff paints word
  // backgrounds on a layer beneath this text, and either would shift the glyphs.
  assert.doesNotMatch(theme, /fontFamily|lineHeight|textShadow/);
});

const tone = (css, name) => {
  const [, r, g, b] = css.match(new RegExp(`--${name}:#(\\w\\w)(\\w\\w)(\\w\\w)`)).map((v, i) => i ? parseInt(v, 16) : v);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

test("each side steps through three distinct shades, darkest to lightest", () => {
  for (const side of ["add", "del"]) {
    const formatting = tone(css, `diff-${side}-formatting`);
    const line = tone(css, `diff-${side}-line`);
    const word = tone(css, `diff-${side}-word`);
    assert.ok(line - formatting > 15, `${side}: formatting and line too close`);
    assert.ok(word - line > 15, `${side}: line and word too close`);
  }
});

test("the red tiers mirror the green ones so neither side dominates", () => {
  for (const step of ["formatting", "line", "word"]) {
    assert.ok(Math.abs(tone(css, `diff-add-${step}`) - tone(css, `diff-del-${step}`)) < 12, `${step} steps are unbalanced`);
  }
});

test("a wholly changed line draws no word box, so insertions form one band", () => {
  assert.match(source, /line\.segments\.every\(\(segment\) => segment\.changed\)\) return null/);
});

test("a formatting-only change is muted rather than coloured like a real edit", () => {
  // Covers a reindent and a rewrap alike: in both the code moved, not changed.
  assert.match(source, /line\.formattingOnly \? styles\.lineFormattingOnly : ""/);
  assert.match(source, /line\.formattingOnly \? styles\.wordFormatting : ""/);
  assert.match(css, /\.lineFormattingOnly\.line_added\{background:var\(--diff-add-formatting\)\}/);
  assert.match(css, /\.wordFormatting\{border-bottom:1px dotted/);
  assert.match(source, /isFormattingOnlyHunk/);
});

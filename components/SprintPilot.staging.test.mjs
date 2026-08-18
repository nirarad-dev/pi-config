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

test("one pull-request gate, with draft and ready chosen on the review screen", () => {
  // Draft-versus-ready is a decision about the title and body, so it is made
  // against them rather than before they exist.
  assert.match(source, /3 · OPEN PULL REQUEST/);
  assert.doesNotMatch(source, /3A ·|3B ·|prSplit/);
  assert.match(source, /const preparePullRequest = async \(\) =>/);
  assert.match(source, /OPEN AS DRAFT/);
  assert.match(source, /OPEN READY FOR REVIEW/);
  // Both actions send the same reviewed text; only the draft flag differs.
  assert.match(source, /gitAction\("pr", \{ draft: mode\.draft, title: pullRequestSetup\.title, description: pullRequestSetup\.description \}\)/);
});

test("only the pressed pull-request button reports progress", () => {
  assert.match(source, /pullRequestSetup\.opening === mode\.draft/);
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

test("the text stacks above the underlay, which is opaque and absolutely positioned", () => {
  // Without this the word backgrounds paint over the characters they mark and
  // the line renders as blocks of colour — the ghost-character regression that
  // arrived with the switch from translucent to opaque tones.
  assert.match(css, /\.codeCell>code\{position:relative;z-index:1\}/);
  assert.match(css, /\.changeUnderlay\{position:absolute/);
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

test("a changed line's number lifts out of the context grey and takes its side's hue", () => {
  assert.match(css, /\.oldLine,\.newLine\{color:#505050\}/);
  assert.match(css, /\.line_added \.oldLine,\.line_added \.newLine\{color:#7f9184\}/);
  assert.match(css, /\.line_removed \.oldLine,\.line_removed \.newLine\{color:#948084\}/);
});

test("word detail is dropped where it would be confetti rather than information", () => {
  const intraline = readFileSync(new URL("../lib/sprintpilot-diff-intraline.ts", import.meta.url), "utf8");
  assert.match(intraline, /MIN_INLINE_SIMILARITY/);
  assert.match(intraline, /MAX_CHANGED_RUNS_PER_LINE/);
  assert.match(intraline, /MIN_LINE_SURVIVAL/);
});

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

test("creating a pull request is not reported as Jira having seen it", () => {
  // Ingest is asynchronous: a check made the instant the PR exists says nothing.
  assert.match(source, /const confirmJiraSeesPullRequest/);
  assert.match(source, /action: "jira-development"/);
  assert.match(source, /action: "jira-nudge"/);
  assert.match(source, /Jira Development shows the pull request/);
  assert.match(source, /Jira has NOT ingested this pull request/);
});

test("a commit that never mentioned the ticket is reported, not silently passed", () => {
  assert.match(source, /commitCarriesKey === false/);
  assert.match(source, /cannot be repaired now, only on the next branch/);
});

test("the operator can see that verification is still running", () => {
  assert.match(source, /jiraWatchToast/);
  assert.match(source, /waiting for Jira to ingest/);
  assert.match(css, /\.jiraWatchToast\{position:fixed/);
});

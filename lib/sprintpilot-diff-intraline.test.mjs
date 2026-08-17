import assert from "node:assert/strict";
import test from "node:test";
import {
  annotateDiffLines,
  diffTokens,
  isFormattingOnlyHunk,
  runSimilarity,
  tokenizeDiffLine,
} from "./sprintpilot-diff-intraline.ts";

const changedText = (line) => line.segments.filter((segment) => segment.changed).map((segment) => segment.text).join("");
const rebuilt = (line) => line.segments.map((segment) => segment.text).join("");
const removed = (content, oldLine) => ({ kind: "removed", content, oldLine });
const added = (content, newLine) => ({ kind: "added", content, newLine });

test("tokenizing keeps every character and never swallows a newline", () => {
  const text = "    return foo(bar, 1)";
  assert.equal(tokenizeDiffLine(text).join(""), text);
  assert.deepEqual(tokenizeDiffLine("a\nb"), ["a", "b"]);
});

test("the token diff reproduces both sides exactly", () => {
  const ops = diffTokens(["a", " ", "b"], ["a", " ", "c"]);
  assert.equal(ops.filter((op) => op.side !== "added").map((op) => op.token).join(""), "a b");
  assert.equal(ops.filter((op) => op.side !== "removed").map((op) => op.token).join(""), "a c");
});

test("only the differing words are marked", () => {
  const [before, after] = annotateDiffLines([
    removed("const timeout = 30_000;", 1),
    added("const timeout = 25_000;", 1),
  ]);
  assert.equal(changedText(before), "30_000");
  assert.equal(changedText(after), "25_000");
});

test("segments always rebuild the original line exactly", () => {
  const cases = [
    [["  if (a) return b;"], ["  if (a && c) return b;"]],
    [["x"], ["y"]],
    [["one", "two"], ["one two"]],
    [["removed only"], []],
    [["same"], ["same"]],
  ];
  for (const [before, after] of cases) {
    const annotated = annotateDiffLines([
      ...before.map((content, index) => removed(content, index + 1)),
      ...after.map((content, index) => added(content, index + 1)),
    ]);
    const rebuiltAll = annotated.map(rebuilt);
    assert.deepEqual(rebuiltAll, [...before, ...after]);
  }
});

test("a line split across three lines marks only the code that changed", () => {
  // The reflow that exposed positional pairing: one signature wrapped onto
  // three lines while a single argument was added.
  const annotated = annotateDiffLines([
    removed("    def correlate(self, env: str, failure_ts: str) -> EnvCorrelationEvidence:", 273),
    added("    def correlate(", 274),
    added("        self, env: str, failure_ts: str, failure_ts_source: str", 275),
    added("    ) -> EnvCorrelationEvidence:", 276),
  ]);
  const [before, first, second, third] = annotated;
  assert.equal(changedText(before).trim(), "", "no code was removed from the original line");
  assert.equal(changedText(first).trim(), "", "the reflowed head is unchanged code");
  assert.match(changedText(second), /failure_ts_source/, "the new argument is the real change");
  assert.equal(changedText(third).trim(), "", "the reflowed tail is unchanged code");
  assert.equal(second.formattingOnly, false);
  assert.equal(first.formattingOnly, true);
  assert.equal(third.formattingOnly, true);
});

test("a docstring whose closing quotes move is formatting, not a change", () => {
  const annotated = annotateDiffLines([
    removed('        """Gather evidence around one failure timestamp."""', 1),
    added('        """Gather evidence around one failure timestamp.', 1),
    added("", 2),
    added('        """', 3),
  ]);
  assert.equal(changedText(annotated[0]), "");
  assert.ok(annotated.every((line) => line.formattingOnly || changedText(line) === ""));
});

test("joining two lines into one is formatting, not a change", () => {
  const annotated = annotateDiffLines([
    removed("value = compute(", 1),
    removed("    a, b)", 2),
    added("value = compute(a, b)", 1),
  ]);
  assert.ok(annotated.every((line) => changedText(line).trim() === ""));
  assert.ok(annotated.every((line) => line.formattingOnly));
});

test("indentation and formatting changes are formatting-only", () => {
  for (const [before, after] of [["    return x", "\treturn x"], ["foo( a, b )", "foo(a, b)"], ["value = 1", "value = 1   "]]) {
    const [, addedLine] = annotateDiffLines([removed(before, 1), added(after, 1)]);
    assert.equal(addedLine.formattingOnly, true, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  }
});

test("a real edit is never called formatting-only", () => {
  const [, addedLine] = annotateDiffLines([removed("return x", 1), added("return y", 1)]);
  assert.equal(addedLine.formattingOnly, false);
  assert.equal(changedText(addedLine), "y");
});

test("a pure insertion has no counterpart and stays fully marked", () => {
  const annotated = annotateDiffLines([added("brand new line", 1)]);
  assert.equal(changedText(annotated[0]), "brand new line");
  assert.equal(annotated[0].formattingOnly, false);
});

test("a pure deletion stays fully marked", () => {
  const annotated = annotateDiffLines([removed("gone", 1)]);
  assert.equal(changedText(annotated[0]), "gone");
});

test("context lines are never marked", () => {
  const annotated = annotateDiffLines([{ kind: "context", content: "unchanged", oldLine: 1, newLine: 1 }]);
  assert.equal(changedText(annotated[0]), "");
  assert.equal(annotated[0].formattingOnly, false);
});

test("a hunk counts as formatting-only when every changed line is", () => {
  const reformatted = annotateDiffLines([
    { kind: "context", content: "def run():", oldLine: 1, newLine: 1 },
    removed("  a = 1", 2),
    added("    a = 1", 2),
  ]);
  assert.equal(isFormattingOnlyHunk(reformatted), true);
  assert.equal(isFormattingOnlyHunk(annotateDiffLines([removed("  a = 1", 1), added("    a = 2", 1)])), false);
  assert.equal(isFormattingOnlyHunk(annotateDiffLines([{ kind: "context", content: "x", oldLine: 1, newLine: 1 }])), false);
});

test("a very large replacement degrades instead of building a huge table", () => {
  const big = (word) => Array.from({ length: 400 }, (_, index) => `${word} line ${index} with several tokens here`);
  const annotated = annotateDiffLines([
    ...big("old").map((content, index) => removed(content, index + 1)),
    ...big("new").map((content, index) => added(content, index + 1)),
  ]);
  assert.equal(annotated.length, 800);
  assert.deepEqual(annotated.map(rebuilt), [...big("old"), ...big("new")]);
});

test("a wholesale rewrite renders as plain bands instead of confetti", () => {
  // The comment block from the screenshot: rewritten outright, yet a token diff
  // still matches "the", "a", "so", and would box each one.
  const annotated = annotateDiffLines([
    removed("    # Drop order is cheapest evidence first: console, then", 328),
    removed("    # the dapp request. Each drop leaves a note so the model knows evidence was", 329),
    removed("    # withheld, not absent.", 330),
    removed("    body = head + dapp_block + visual_block + console_block", 331),
    added("    # Listed in prompt order; dropped from the tail backwards, so the cheapest", 368),
    added("    # evidence (console) goes first and the network block last - it names which", 369),
    added("    # request failed, which is what the rest of the evidence is trying to", 370),
    added("    # explain. Each drop leaves a note so the model knows evidence was withheld,", 371),
    added("    # not absent.", 372),
    added("    optional_blocks: list[tuple[list[str], str]] = [", 373),
  ]);
  for (const line of annotated) {
    const visibleRuns = line.segments.filter((s) => s.changed && s.text.trim()).length;
    assert.ok(visibleRuns <= 2, `line is speckled with ${visibleRuns} marks: ${line.content.slice(0, 40)}`);
  }
  // The lines that were genuinely replaced carry no word marks at all.
  const replaced = annotated.filter((line) => /Drop order|optional_blocks|body = head|Listed in prompt/.test(line.content));
  assert.equal(replaced.length, 4);
  for (const line of replaced) {
    assert.ok(!line.segments.some((s) => !s.changed), `should be a plain band: ${line.content.slice(0, 40)}`);
  }
  // Lines that survived nearly intact keep their detail — that is the point of
  // word-level marking, and is more useful than the band an alignment-based
  // editor would draw for them.
  const survivor = annotated.find((line) => line.content.includes("Each drop leaves a note"));
  assert.ok(survivor.segments.some((s) => !s.changed), "a near-identical line keeps its unchanged run");
});

test("a similar pair still gets its word-level detail", () => {
  // Two signatures that share their shape: the detail is worth showing.
  const annotated = annotateDiffLines([
    removed("        def _over_budget() -> bool:", 334),
    added("        def _render() -> list[str]:", 382),
  ]);
  const marked = annotated.map((line) => line.segments.filter((s) => s.changed).map((s) => s.text).join(""));
  assert.match(marked[0], /_over_budget/);
  assert.match(marked[1], /_render/);
  assert.ok(annotated[0].segments.some((s) => !s.changed), "the shared shape stays unmarked");
});

test("similarity is measured against the longer side", () => {
  const short = diffTokens(tokenizeDiffLine("a b c"), tokenizeDiffLine("a b c"));
  assert.equal(runSimilarity(short), 1);
  // Every original character reappears, but among far more new text.
  const grown = diffTokens(
    tokenizeDiffLine("x = 1"),
    tokenizeDiffLine("x = 1 plus a great deal of entirely new material here besides"),
  );
  assert.ok(runSimilarity(grown) < 0.35, `expected a low score, got ${runSimilarity(grown)}`);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  annotateDiffLines,
  diffTokens,
  isFormattingOnlyHunk,
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

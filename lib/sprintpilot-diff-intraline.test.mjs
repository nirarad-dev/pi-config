import assert from "node:assert/strict";
import test from "node:test";
import {
  annotateDiffLines,
  isWhitespaceOnlyChange,
  isWhitespaceOnlyHunk,
  segmentPair,
  tokenizeDiffLine,
} from "./sprintpilot-diff-intraline.ts";

const changedText = (segments) => segments.filter((segment) => segment.changed).map((segment) => segment.text).join("");
const rebuilt = (segments) => segments.map((segment) => segment.text).join("");

test("tokenizing keeps every character, whitespace included", () => {
  const text = "    return foo(bar, 1)";
  assert.equal(tokenizeDiffLine(text).join(""), text);
});

test("only the differing words are marked", () => {
  const { before, after } = segmentPair("const timeout = 30_000;", "const timeout = 25_000;");
  assert.equal(changedText(before), "30_000");
  assert.equal(changedText(after), "25_000");
});

test("segments always rebuild the original line exactly", () => {
  const pairs = [
    ["  if (a) return b;", "  if (a && c) return b;"],
    ["x", "y"],
    ["", "added line"],
    ["removed line", ""],
    ["same", "same"],
  ];
  for (const [before, after] of pairs) {
    const segments = segmentPair(before, after);
    assert.equal(rebuilt(segments.before), before);
    assert.equal(rebuilt(segments.after), after);
  }
});

test("an identical pair marks nothing as changed", () => {
  const { before, after } = segmentPair("same line", "same line");
  assert.equal(changedText(before), "");
  assert.equal(changedText(after), "");
});

test("a change at the start of the line is found", () => {
  const { after } = segmentPair("let value = 1;", "const value = 1;");
  assert.equal(changedText(after), "const");
});

test("indentation and formatting changes are whitespace-only", () => {
  assert.equal(isWhitespaceOnlyChange("    return x", "\treturn x"), true);
  assert.equal(isWhitespaceOnlyChange("foo( a, b )", "foo(a, b)"), true);
  assert.equal(isWhitespaceOnlyChange("value = 1", "value = 1   "), true);
});

test("a real edit is never called whitespace-only", () => {
  assert.equal(isWhitespaceOnlyChange("return x", "return y"), false);
  assert.equal(isWhitespaceOnlyChange("  return x", "  return xy"), false);
  assert.equal(isWhitespaceOnlyChange("same", "same"), false);
});

test("a replacement pairs the nth removal with the nth addition", () => {
  const annotated = annotateDiffLines([
    { kind: "context", content: "def run():", oldLine: 1, newLine: 1 },
    { kind: "removed", content: "    timeout = 30", oldLine: 2 },
    { kind: "removed", content: "    retries = 1", oldLine: 3 },
    { kind: "added", content: "    timeout = 45", newLine: 2 },
    { kind: "added", content: "    retries = 3", newLine: 3 },
  ]);
  assert.equal(changedText(annotated[1].segments), "30");
  assert.equal(changedText(annotated[2].segments), "1");
  assert.equal(changedText(annotated[3].segments), "45");
  assert.equal(changedText(annotated[4].segments), "3");
  assert.equal(annotated[0].segments[0].changed, false);
});

test("a pure insertion has no counterpart and stays fully marked", () => {
  const annotated = annotateDiffLines([
    { kind: "removed", content: "old", oldLine: 1 },
    { kind: "added", content: "new", newLine: 1 },
    { kind: "added", content: "extra", newLine: 2 },
  ]);
  assert.equal(changedText(annotated[2].segments), "extra");
  assert.equal(annotated[2].whitespaceOnly, false);
});

test("a reindented line is flagged on both sides", () => {
  const annotated = annotateDiffLines([
    { kind: "removed", content: "  return value", oldLine: 1 },
    { kind: "added", content: "    return value", newLine: 1 },
  ]);
  assert.equal(annotated[0].whitespaceOnly, true);
  assert.equal(annotated[1].whitespaceOnly, true);
});

test("a hunk counts as whitespace-only when every changed line is", () => {
  const reformatted = annotateDiffLines([
    { kind: "context", content: "def run():", oldLine: 1, newLine: 1 },
    { kind: "removed", content: "  a = 1", oldLine: 2 },
    { kind: "added", content: "    a = 1", newLine: 2 },
  ]);
  assert.equal(isWhitespaceOnlyHunk(reformatted), true);

  const mixed = annotateDiffLines([
    { kind: "removed", content: "  a = 1", oldLine: 1 },
    { kind: "added", content: "    a = 2", newLine: 1 },
  ]);
  assert.equal(isWhitespaceOnlyHunk(mixed), false);
});

test("a hunk with no changed lines is not whitespace-only", () => {
  const annotated = annotateDiffLines([{ kind: "context", content: "x", oldLine: 1, newLine: 1 }]);
  assert.equal(isWhitespaceOnlyHunk(annotated), false);
});

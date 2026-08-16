import assert from "node:assert/strict";
import test from "node:test";
import { parseDiff } from "./sprintpilot-diff.ts";

test("parses unified diff hunks into editor lines with old and new line numbers", () => {
  const hunks = parseDiff(`diff --git a/example.ts b/example.ts
--- a/example.ts
+++ b/example.ts
@@ -4,3 +4,4 @@ function example() {
 context
-old value
+new value
+another value
 end`);

  assert.deepEqual(hunks, [{
    label: "function example() {",
    lines: [
      { kind: "context", content: "context", oldLine: 4, newLine: 4 },
      { kind: "removed", content: "old value", oldLine: 5 },
      { kind: "added", content: "new value", newLine: 5 },
      { kind: "added", content: "another value", newLine: 6 },
      { kind: "context", content: "end", oldLine: 6, newLine: 7 },
    ],
  }]);
});

test("omits Git metadata and no-newline markers from editor lines", () => {
  const hunks = parseDiff(`index 123..456 100644
@@ -1 +1 @@
-before
\\ No newline at end of file
+after
\\ No newline at end of file`);

  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0].lines.map((line) => line.content), ["before", "after"]);
});

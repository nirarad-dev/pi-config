import assert from "node:assert/strict";
import test from "node:test";
import { parseSprintPilotGitHistory } from "./sprintpilot-git-history.ts";

test("parses commits and preserves native git graph connector rows", () => {
  const output = [
    "*   \u001e1234567890123456789012345678901234567890\u001f1234567\u001faaaa bbbb\u001fHEAD -> main, tag: v2\u001fAda\u001f2026-08-16T12:00:00+03:00\u001fMerge feature",
    "|\\  ",
    "| * \u001eaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\u001faaaaaaa\u001fbbbb\u001ffeature\u001fLin\u001f2026-08-15T09:00:00+03:00\u001fAdd graph",
  ].join("\n");

  assert.deepEqual(parseSprintPilotGitHistory(output), [
    {
      kind: "commit",
      graph: "*   ",
      hash: "1234567890123456789012345678901234567890",
      shortHash: "1234567",
      parents: ["aaaa", "bbbb"],
      refs: ["HEAD -> main", "tag: v2"],
      author: "Ada",
      authoredAt: "2026-08-16T12:00:00+03:00",
      subject: "Merge feature",
    },
    { kind: "connector", graph: "|\\  " },
    {
      kind: "commit",
      graph: "| * ",
      hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      shortHash: "aaaaaaa",
      parents: ["bbbb"],
      refs: ["feature"],
      author: "Lin",
      authoredAt: "2026-08-15T09:00:00+03:00",
      subject: "Add graph",
    },
  ]);
});

test("returns no history for an empty repository response", () => {
  assert.deepEqual(parseSprintPilotGitHistory("\n"), []);
});

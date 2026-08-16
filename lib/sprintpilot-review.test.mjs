import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewFixPrompt } from "./sprintpilot-review.ts";

test("builds a fix prompt with precise new and old line references", () => {
  const prompt = buildReviewFixPrompt("DEV-42", [
    { id: "1", filePath: "src/new.ts", line: 8, side: "new", kind: "added", code: "return false;", body: "Return the computed value." },
    { id: "2", filePath: "src/old.ts", line: 3, side: "old", kind: "removed", code: "legacy();", body: "Preserve the cleanup call." },
  ]);

  assert.match(prompt, /Fix the following code review comments for DEV-42/);
  assert.match(prompt, /src\/new\.ts:line 8 \(added\)/);
  assert.match(prompt, /src\/old\.ts:old line 3 \(removed\)/);
  assert.match(prompt, /Do not stage, commit, push, or open a PR/);
});

test("omits comments already sent to the agent", () => {
  const prompt = buildReviewFixPrompt("DEV-42", [
    { id: "1", filePath: "src/sent.ts", line: 1, side: "new", kind: "added", code: "sent", body: "Sent", sentAt: "2026-08-16T00:00:00.000Z" },
    { id: "2", filePath: "src/pending.ts", line: 2, side: "new", kind: "context", code: "pending", body: "Pending" },
  ]);

  assert.doesNotMatch(prompt, /sent\.ts/);
  assert.match(prompt, /pending\.ts/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { buildSprintPilotCommitMessage, parseSprintPilotCommitMessage } from "./sprintpilot-commit-message.ts";

test("builds a high-level message from approved file patches", () => {
  const patch = `diff --git a/components/View.tsx b/components/View.tsx
--- a/components/View.tsx
+++ b/components/View.tsx
@@ -1 +1 @@
+export function HistoryGraph() {}
diff --git a/lib/history.test.ts b/lib/history.test.ts
new file mode 100644
--- /dev/null
+++ b/lib/history.test.ts
@@ -0,0 +1 @@
+const parsesMerges = true;`;
  assert.equal(buildSprintPilotCommitMessage("DEV-42: Show history", ["components/View.tsx", "lib/history.test.ts"], patch), `DEV-42: Show history

- Update components/View.tsx around HistoryGraph
- Cover lib/history.test.ts around parsesMerges`);
});

test("includes approved untracked files even when Git has no patch yet", () => {
  assert.match(buildSprintPilotCommitMessage("DEV-1: Add config", ["config/new.json"], ""), /- Add config\/new.json/);
});

test("a well-formed model draft is kept verbatim", () => {
  const raw = "DEV-42: Show branch history in the review panel\n\n- Render merge commits as a graph so reviewers can see branch topology\n- Page history in blocks of 200 to keep long branches responsive";
  assert.deepEqual(parseSprintPilotCommitMessage(raw, "FALLBACK", "DEV-42"), {
    message: raw,
    generatedBy: "agent",
  });
});

test("a missing ticket prefix is repaired instead of discarding the draft", () => {
  const result = parseSprintPilotCommitMessage("Show branch history\n\n- Render merge commits as a graph", "FALLBACK", "DEV-42");
  assert.equal(result.generatedBy, "repaired");
  assert.equal(result.message, "DEV-42: Show branch history\n\n- Render merge commits as a graph");
});

test("an over-long subject is truncated rather than rejected", () => {
  const result = parseSprintPilotCommitMessage(`DEV-42: ${"x".repeat(140)}\n\n- Something concrete`, "FALLBACK", "DEV-42");
  assert.equal(result.generatedBy, "repaired");
  assert.ok(result.message.split("\n")[0].length <= 100);
});

test("code fences around an otherwise valid draft are stripped", () => {
  const result = parseSprintPilotCommitMessage("```\nDEV-42: Show history\n\n- Render merge commits\n```", "FALLBACK", "DEV-42");
  assert.equal(result.generatedBy, "agent");
  assert.equal(result.message, "DEV-42: Show history\n\n- Render merge commits");
});

test("prose with no bullets falls back to the deterministic snapshot message", () => {
  assert.deepEqual(parseSprintPilotCommitMessage("Sure! Here is a commit message for you.", "FALLBACK", "DEV-42"), {
    message: "FALLBACK",
    generatedBy: "fallback",
  });
});

test("an empty model response falls back", () => {
  assert.equal(parseSprintPilotCommitMessage("", "FALLBACK", "DEV-42").generatedBy, "fallback");
});

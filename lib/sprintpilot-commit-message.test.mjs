import assert from "node:assert/strict";
import test from "node:test";
import { buildSprintPilotCommitMessage } from "./sprintpilot-commit-message.ts";

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

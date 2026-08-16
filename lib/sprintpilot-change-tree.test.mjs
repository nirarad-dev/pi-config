import assert from "node:assert/strict";
import test from "node:test";
import { buildSprintPilotChangeTree } from "./sprintpilot-change-tree.ts";

test("groups changed files into sorted directory nodes", () => {
  const tree = buildSprintPilotChangeTree([
    { filePath: "components/Zeta.tsx", status: "M" },
    { filePath: "README.md", status: "M" },
    { filePath: "components/forms/Input.tsx", status: "A" },
    { filePath: "components/Alpha.tsx", status: "D" },
  ]);

  assert.deepEqual(tree, [
    {
      kind: "directory",
      name: "components",
      path: "components",
      fileCount: 3,
      children: [
        {
          kind: "directory",
          name: "forms",
          path: "components/forms",
          fileCount: 1,
          children: [{ kind: "file", name: "Input.tsx", path: "components/forms/Input.tsx", status: "A" }],
        },
        { kind: "file", name: "Alpha.tsx", path: "components/Alpha.tsx", status: "D" },
        { kind: "file", name: "Zeta.tsx", path: "components/Zeta.tsx", status: "M" },
      ],
    },
    { kind: "file", name: "README.md", path: "README.md", status: "M" },
  ]);
});

test("normalizes Windows separators", () => {
  const tree = buildSprintPilotChangeTree([{ filePath: "lib\\nested\\file.ts", status: "M" }]);
  assert.equal(tree[0].kind, "directory");
  assert.equal(tree[0].path, "lib");
  assert.equal(tree[0].children[0].kind, "directory");
  assert.equal(tree[0].children[0].children[0].path, "lib/nested/file.ts");
});

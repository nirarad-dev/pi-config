import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const extensionPath = new URL(".", import.meta.url).pathname.replace(/\/$/, "");

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
}

/** A main repository plus one linked worktree, matching SprintPilot's layout. */
function createRepositoryWithWorktree() {
  const root = mkdtempSync(join(tmpdir(), "sprintpilot-guard-"));
  const main = join(root, "repo");
  git(["init", "-q", "-b", "main", "repo"], root);
  writeFileSync(join(main, "README.md"), "hello\n");
  git(["add", "README.md"], main);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], main);
  const worktree = join(root, "wt-DEV-1");
  git(["worktree", "add", "-q", "-b", "nir/DEV-1-guard", worktree], main);
  return { root, main, worktree };
}

async function loadHandler() {
  const result = await discoverAndLoadExtensions([extensionPath], process.cwd());
  assert.equal(result.extensions.length, 1, "the extension should load");
  const handlers = result.extensions[0].handlers.get("tool_call");
  assert.ok(handlers?.length, "a tool_call handler should be registered");
  return handlers[0];
}

function context(cwd) {
  return { cwd, ui: { setStatus() {}, notify() {} } };
}

test("pi loads the extension with its guard and every workflow command", async () => {
  const result = await discoverAndLoadExtensions([extensionPath], process.cwd());
  assert.deepEqual(result.diagnostics ?? [], []);
  assert.ok(result.extensions[0].handlers.has("tool_call"));
  assert.deepEqual([...result.extensions[0].commands.keys()].slice(0, 3), ["sp-plan", "sp-develop", "sp-test"]);
});

test("a Git write is blocked inside a linked worktree and allowed in the main repository", async (t) => {
  const handler = await loadHandler();
  const repository = createRepositoryWithWorktree();
  t.after(() => rmSync(repository.root, { recursive: true, force: true }));

  const inWorktree = await handler(
    { type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "git commit -m done" } },
    context(repository.worktree),
  );
  assert.equal(inWorktree?.block, true);
  assert.match(inWorktree.reason, /SprintPilot blocks `git commit`/);

  // The main checkout is ordinary work, not a SprintPilot task worktree.
  const inMain = await handler(
    { type: "tool_call", toolCallId: "2", toolName: "bash", input: { command: "git commit -m done" } },
    context(repository.main),
  );
  assert.equal(inMain, undefined);
});

test("read-only commands still run inside a guarded worktree", async (t) => {
  const handler = await loadHandler();
  const repository = createRepositoryWithWorktree();
  t.after(() => rmSync(repository.root, { recursive: true, force: true }));

  for (const command of ["git status --porcelain", "git diff HEAD", "npm test"]) {
    const verdict = await handler(
      { type: "tool_call", toolCallId: "3", toolName: "bash", input: { command } },
      context(repository.worktree),
    );
    assert.equal(verdict, undefined, `expected to allow: ${command}`);
  }
});

test("writes into .git are blocked inside a guarded worktree", async (t) => {
  const handler = await loadHandler();
  const repository = createRepositoryWithWorktree();
  t.after(() => rmSync(repository.root, { recursive: true, force: true }));

  const verdict = await handler(
    { type: "tool_call", toolCallId: "4", toolName: "write", input: { path: ".git/hooks/pre-commit" } },
    context(repository.worktree),
  );
  assert.equal(verdict?.block, true);

  const allowed = await handler(
    { type: "tool_call", toolCallId: "5", toolName: "write", input: { path: "lib/thing.ts" } },
    context(repository.worktree),
  );
  assert.equal(allowed, undefined);
});

test("tools other than bash, write, and edit are never inspected", async (t) => {
  const handler = await loadHandler();
  const repository = createRepositoryWithWorktree();
  t.after(() => rmSync(repository.root, { recursive: true, force: true }));

  const verdict = await handler(
    { type: "tool_call", toolCallId: "6", toolName: "read", input: { path: ".git/config" } },
    context(repository.worktree),
  );
  assert.equal(verdict, undefined);
});

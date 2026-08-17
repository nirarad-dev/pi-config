import assert from "node:assert/strict";
import test from "node:test";
import { inspectSprintPilotCommand, inspectSprintPilotPath, splitShellSegments } from "./sprintpilot-git-guard.ts";

const blocked = (command) => inspectSprintPilotCommand(command).blocked;

test("the documented Git writes are blocked", () => {
  for (const command of [
    "git add .",
    "git add -A",
    "git commit -m 'done'",
    "git commit -am 'done'",
    "git push",
    "git push --set-upstream origin nir/DEV-1-x",
    "git stash",
    "git reset --hard origin/main",
    "git restore --staged lib/thing.ts",
    "git rm lib/thing.ts",
    "git rebase origin/main",
    "git checkout -b nir/DEV-2-y",
    "git worktree remove /tmp/wt",
  ]) {
    assert.equal(blocked(command), true, `expected to block: ${command}`);
  }
});

test("read-only Git stays available to the agent", () => {
  for (const command of [
    "git status --porcelain",
    "git diff HEAD",
    "git log --oneline -10",
    "git show HEAD",
    "git branch --show-current",
    "git branch --list",
    "git stash list",
    "git worktree list",
    "git rev-parse --show-toplevel",
    "git blame lib/thing.ts",
    "git restore lib/thing.ts",
  ]) {
    assert.equal(blocked(command), false, `expected to allow: ${command}`);
  }
});

test("GitHub publishing commands are blocked but reads are not", () => {
  assert.equal(blocked("gh pr create --draft"), true);
  assert.equal(blocked("gh pr merge 12"), true);
  assert.equal(blocked("gh pr comment 12 --body hi"), true);
  assert.equal(blocked("gh api -X POST /repos/x/y/issues"), true);
  assert.equal(blocked("gh pr view 12"), false);
  assert.equal(blocked("gh pr checks 12"), false);
  assert.equal(blocked("gh run view 5"), false);
});

test("a write hidden later in a chained command is still caught", () => {
  assert.equal(blocked("npm test && git commit -m 'green'"), true);
  assert.equal(blocked("git status; git add ."), true);
  assert.equal(blocked("git diff | tee out.txt"), false);
  assert.equal(blocked("echo hi\ngit push"), true);
});

test("env assignments, sudo, and absolute paths do not hide the program", () => {
  assert.equal(blocked("GIT_AUTHOR_NAME=x git commit -m y"), true);
  assert.equal(blocked("env FOO=1 git push"), true);
  assert.equal(blocked("/usr/bin/git commit -m y"), true);
  assert.equal(blocked("command git add ."), true);
});

test("git's own pre-subcommand options do not hide the subcommand", () => {
  assert.equal(blocked("git -C /tmp/wt commit -m y"), true);
  assert.equal(blocked("git -c user.name=x commit -m y"), true);
  assert.equal(blocked("git --git-dir /tmp/.git push"), true);
  assert.equal(blocked("git -C /tmp/wt status"), false);
});

test("a separator inside quotes does not split the command", () => {
  assert.deepEqual(splitShellSegments("git commit -m \"a && b\""), ["git commit -m \"a && b\""]);
  assert.equal(blocked("echo 'git commit is blocked'"), false);
});

test("a commit message mentioning git does not trigger the guard", () => {
  assert.equal(blocked("echo \"remember to git push later\""), false);
});

test("writes into .git are refused", () => {
  assert.equal(inspectSprintPilotPath(".git/config").blocked, true);
  assert.equal(inspectSprintPilotPath("/repo/.git/hooks/pre-commit").blocked, true);
  assert.equal(inspectSprintPilotPath("lib/git-changes.ts").blocked, false);
  assert.equal(inspectSprintPilotPath("docs/.gitignore").blocked, false);
});

test("a blocked verdict always explains itself", () => {
  const verdict = inspectSprintPilotCommand("git commit -m y");
  assert.equal(verdict.blocked, true);
  assert.match(verdict.reason, /SprintPilot blocks/);
  assert.match(verdict.reason, /review panel/);
});

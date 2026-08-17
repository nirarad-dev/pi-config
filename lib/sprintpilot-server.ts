import { createHash, randomUUID } from "crypto";
import { execFile } from "child_process";
import { existsSync, readFileSync, realpathSync } from "fs";
import { dirname, isAbsolute, resolve } from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024;

export async function run(command: string, args: string[], cwd?: string, env?: Record<string, string>) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd,
    env: { ...process.env, ...env, LC_ALL: "C" },
    timeout: 30 * 60_000,
    maxBuffer: MAX_BUFFER,
  });
  return `${stdout}${stderr}`.trim();
}

export function configuredRepoRoot(): string {
  return resolve(process.env.SPRINTPILOT_REPO_ROOT || "/Users/nirarad/git/arnac");
}

export function sprintPilotTicketTail(key: string, summary: string): string {
  const slug = summary.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 42).replace(/-$/g, "") || "task";
  return `${key}-${slug}`;
}

export function sprintPilotBranchName(key: string, summary: string): string {
  return `nir/${sprintPilotTicketTail(key, summary)}`;
}

export function matchingSprintPilotBranch(branches: string[], requestedBranch: string): string | undefined {
  const normalized = requestedBranch.toLowerCase();
  return branches.find((branch) => branch.toLowerCase() === normalized);
}

export function sprintPilotWorktreeAddArgs(branch: string, worktree: string, reuseBranch: boolean): string[] {
  return reuseBranch
    ? ["worktree", "add", worktree, branch]
    : ["worktree", "add", "--no-track", "-b", branch, worktree, "origin/main"];
}

export async function resolveSprintRepository(candidate: unknown = configuredRepoRoot()): Promise<string> {
  if (typeof candidate !== "string" || !isAbsolute(candidate)) throw new Error("An absolute repository path is required");
  if (!existsSync(candidate)) throw new Error(`Repository does not exist: ${candidate}`);
  const repo = realpathSync(candidate);
  const top = realpathSync((await run("git", ["rev-parse", "--show-toplevel"], repo)).trim());
  if (top !== repo) throw new Error("Select the root of a Git repository");
  return repo;
}

export async function registeredSprintWorktrees(repoRoot: unknown = configuredRepoRoot()): Promise<Map<string, string | undefined>> {
  const repo = await resolveSprintRepository(repoRoot);
  const output = await run("git", ["worktree", "list", "--porcelain"], repo);
  const worktrees = new Map<string, string | undefined>();
  for (const block of output.split(/\n\n+/)) {
    const lines = block.split("\n");
    const path = lines.find((line) => line.startsWith("worktree "))?.slice(9);
    if (!path || !existsSync(path)) continue;
    const branch = lines.find((line) => line.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "");
    worktrees.set(realpathSync(path), branch);
  }
  return worktrees;
}

export async function sprintRepositoryForWorktree(cwd: unknown): Promise<string> {
  if (typeof cwd !== "string" || !cwd.startsWith("/")) throw new Error("An absolute worktree path is required");
  if (!existsSync(cwd)) throw new Error(`Worktree does not exist: ${cwd}`);
  const realCwd = realpathSync(cwd);
  const top = realpathSync((await run("git", ["rev-parse", "--show-toplevel"], realCwd)).trim());
  if (top !== realCwd) throw new Error("The path must be the worktree root");
  const commonDirectory = (await run("git", ["rev-parse", "--git-common-dir"], realCwd)).trim();
  const commonPath = realpathSync(isAbsolute(commonDirectory) ? commonDirectory : resolve(realCwd, commonDirectory));
  const repo = await resolveSprintRepository(dirname(commonPath));
  const registered = await registeredSprintWorktrees(repo);
  if (!registered.has(realCwd)) throw new Error("Path is not a registered worktree of its repository");
  const [repoRemote, worktreeRemote] = await Promise.all([
    run("git", ["remote", "get-url", "origin"], repo),
    run("git", ["remote", "get-url", "origin"], realCwd),
  ]);
  if (repoRemote.trim() !== worktreeRemote.trim()) throw new Error("Worktree origin does not match its repository");
  return repo;
}

export async function assertSprintWorktree(cwd: unknown): Promise<string> {
  await sprintRepositoryForWorktree(cwd);
  const realCwd = realpathSync(String(cwd));
  return realCwd;
}

function safeRelativeFiles(files: unknown): string[] {
  if (!Array.isArray(files) || files.length === 0) throw new Error("Select at least one changed file");
  const selected = [...new Set(files.map(String))];
  for (const file of selected) {
    if (!file || file.startsWith("/") || file.split(/[\\/]/).includes("..")) throw new Error(`Invalid file path: ${file}`);
  }
  return selected.sort();
}

/**
 * Paths Git currently reports as changed in this worktree.
 *
 * Renames report both sides; either name is a legitimate thing to commit.
 */
export function parseChangedPaths(output: string): Set<string> {
  const records = output.split("\0");
  const paths = new Set<string>();
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record || record.length < 4 || record[2] !== " ") continue;
    paths.add(record.slice(3));
    // A rename emits the original path as the following NUL-separated record.
    // Both names are legitimate things to commit, and skipping the extra record
    // keeps it from being misread as another status line.
    if ("RC".includes(record[0]) || "RC".includes(record[1])) {
      const original = records[++index];
      if (original) paths.add(original);
    }
  }
  return paths;
}

export async function changedPaths(cwd: string): Promise<Set<string>> {
  // Deliberately NOT through `run()`, which trims its output. A porcelain
  // record for an unstaged change begins with a space (" M path"), so trimming
  // shifts the first record's status field and the parser drops that one file —
  // reporting the operator's first changed file as "not changed".
  //
  // Parsed here rather than through lib/git-status.ts because this module is
  // loaded directly by its unit test under node's type-stripping loader, which
  // cannot resolve the extensionless relative imports the rest of lib/ uses.
  const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd,
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: MAX_BUFFER,
  });
  return parseChangedPaths(stdout);
}

export async function snapshotChanges(cwd: string, filesInput: unknown): Promise<{ files: string[]; hash: string }> {
  const files = safeRelativeFiles(filesInput);
  // Every approved file must be one Git actually reports as changed. The commit
  // action stages with `git add -f`, because a tracked file inside a directory
  // matched by .gitignore cannot be staged otherwise; this check is what keeps
  // that `-f` narrow. Without it a crafted request could name any ignored path
  // — a local `.env`, a credentials file — and force it into a commit.
  const changed = await changedPaths(cwd);
  const unknown = files.filter((file) => !changed.has(file));
  if (unknown.length > 0) {
    throw new Error(`Git does not report these files as changed: ${unknown.join(", ")}`);
  }
  const hash = createHash("sha256");
  hash.update(await run("git", ["rev-parse", "HEAD"], cwd));
  hash.update(await run("git", ["status", "--porcelain=v1", "--", ...files], cwd));
  for (const file of files) {
    const absolute = resolve(cwd, file);
    if (absolute !== cwd && !absolute.startsWith(`${cwd}/`)) throw new Error(`Invalid file path: ${file}`);
    hash.update(file);
    hash.update(existsSync(absolute) ? readFileSync(absolute) : Buffer.from("<deleted>"));
  }
  return { files, hash: hash.digest("hex") };
}

type Approval = { cwd: string; files: string[]; hash: string };
declare global { var __sprintPilotApprovals: Map<string, Approval> | undefined; }

function approvals() {
  globalThis.__sprintPilotApprovals ||= new Map();
  return globalThis.__sprintPilotApprovals;
}

/**
 * Approvals do not expire.
 *
 * The file list is the operator's own checkbox selection in the review panel,
 * and committing is their explicit click; a clock adds no safety on top of
 * that. The expiry only ever fired while the operator was reading the drafted
 * message, turning a finished review into "Approval expired; review the changes
 * again". What actually guards the commit is the content hash below, which
 * still refuses to commit bytes that changed since the diff was reviewed.
 */
export function createApproval(cwd: string, files: string[], hash: string) {
  const token = randomUUID();
  approvals().set(token, { cwd, files, hash });
  return token;
}

export function readApproval(token: unknown): Approval {
  if (typeof token !== "string") throw new Error("Approval token is required");
  const approval = approvals().get(token);
  if (!approval) throw new Error("That approval is no longer available; review the changes and draft the commit message again");
  return approval;
}

/**
 * Release an approval once its commit has actually landed.
 *
 * Deliberately separate from reading it. `takeApproval` used to delete the
 * token before validating anything, so any later failure — a hash mismatch, or
 * a `git add` that refused an ignored path — consumed the approval anyway and
 * every retry reported "Approval expired", which described neither problem.
 */
export function releaseApproval(token: unknown): void {
  if (typeof token === "string") approvals().delete(token);
}

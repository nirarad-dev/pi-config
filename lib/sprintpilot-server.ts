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

export async function snapshotChanges(cwd: string, filesInput: unknown): Promise<{ files: string[]; hash: string }> {
  const files = safeRelativeFiles(filesInput);
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

type Approval = { cwd: string; files: string[]; hash: string; expiresAt: number };
declare global { var __sprintPilotApprovals: Map<string, Approval> | undefined; }

function approvals() {
  globalThis.__sprintPilotApprovals ||= new Map();
  return globalThis.__sprintPilotApprovals;
}

export function createApproval(cwd: string, files: string[], hash: string) {
  const token = randomUUID();
  approvals().set(token, { cwd, files, hash, expiresAt: Date.now() + 30 * 60_000 });
  return token;
}

export function takeApproval(token: unknown): Approval {
  if (typeof token !== "string") throw new Error("Approval token is required");
  const approval = approvals().get(token);
  approvals().delete(token);
  if (!approval || approval.expiresAt < Date.now()) throw new Error("Approval expired; review the changes again");
  return approval;
}

export function readApproval(token: unknown): Approval {
  if (typeof token !== "string") throw new Error("Approval token is required");
  const approval = approvals().get(token);
  if (!approval || approval.expiresAt < Date.now()) {
    if (approval) approvals().delete(token);
    throw new Error("Approval expired; review the changes again");
  }
  return approval;
}

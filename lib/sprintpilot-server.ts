import { createHash, randomUUID } from "crypto";
import { execFile } from "child_process";
import { existsSync, readFileSync, realpathSync } from "fs";
import { basename, dirname, resolve } from "path";
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

export async function assertSprintWorktree(cwd: unknown): Promise<string> {
  if (typeof cwd !== "string" || !cwd.startsWith("/")) throw new Error("An absolute worktree path is required");
  if (!existsSync(cwd)) throw new Error(`Worktree does not exist: ${cwd}`);
  const realCwd = realpathSync(cwd);
  const repo = realpathSync(configuredRepoRoot());
  const top = realpathSync((await run("git", ["rev-parse", "--show-toplevel"], realCwd)).trim());
  if (top !== realCwd) throw new Error("The path must be the worktree root");
  const allowedParent = dirname(repo);
  const allowedPrefix = `${basename(repo)}-`;
  if (realCwd !== repo && (dirname(realCwd) !== allowedParent || !basename(realCwd).startsWith(allowedPrefix))) {
    throw new Error("Worktree is outside the configured SprintPilot repository family");
  }
  const [repoRemote, worktreeRemote] = await Promise.all([
    run("git", ["remote", "get-url", "origin"], repo),
    run("git", ["remote", "get-url", "origin"], realCwd),
  ]);
  if (repoRemote.trim() !== worktreeRemote.trim()) throw new Error("Worktree origin does not match the configured repository");
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

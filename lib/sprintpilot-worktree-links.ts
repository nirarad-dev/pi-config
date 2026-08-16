import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";

type LinkState = {
  version: 1;
  repositories: Record<string, Record<string, { worktree: string; linkedAt: string }>>;
};

const emptyState = (): LinkState => ({ version: 1, repositories: {} });

export function sprintPilotLinkFile() {
  return resolve(process.env.SPRINTPILOT_STATE_FILE || join(homedir(), ".pi", "sprintpilot", "worktrees.json"));
}

function readState(): LinkState {
  const file = sprintPilotLinkFile();
  if (!existsSync(file)) return emptyState();
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<LinkState>;
  if (parsed.version !== 1 || !parsed.repositories || typeof parsed.repositories !== "object" || Array.isArray(parsed.repositories)) {
    throw new Error(`Invalid SprintPilot worktree config: ${file}`);
  }
  return { version: 1, repositories: parsed.repositories };
}

function writeState(state: LinkState) {
  const file = sprintPilotLinkFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, file);
}

export function persistedWorktreeLinks(repoRoot: string): Map<string, string> {
  const entries = readState().repositories[resolve(repoRoot)] || {};
  return new Map(Object.entries(entries).flatMap(([key, entry]) =>
    /^[A-Z][A-Z0-9]+-\d+$/.test(key) && entry && typeof entry.worktree === "string" ? [[key, entry.worktree]] : []
  ));
}

export function persistWorktreeLink(repoRoot: string, key: string, worktree: string) {
  const state = readState();
  const repository = resolve(repoRoot);
  state.repositories[repository] ||= {};
  state.repositories[repository][key] = { worktree: resolve(worktree), linkedAt: new Date().toISOString() };
  writeState(state);
}

export function forgetWorktreeLink(repoRoot: string, worktree: string) {
  const state = readState();
  const repository = resolve(repoRoot);
  const links = state.repositories[repository];
  if (!links) return;
  const target = resolve(worktree);
  for (const [key, entry] of Object.entries(links)) {
    if (resolve(entry.worktree) === target) delete links[key];
  }
  if (!Object.keys(links).length) delete state.repositories[repository];
  writeState(state);
}

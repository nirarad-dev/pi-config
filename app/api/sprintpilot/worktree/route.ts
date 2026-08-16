import { existsSync, realpathSync } from "fs";
import { basename, dirname, isAbsolute, join, relative } from "path";
import { NextResponse } from "next/server";
import { allowFileRoot } from "@/lib/file-access";
import { assertSprintWorktree, configuredRepoRoot, matchingSprintPilotBranch, registeredSprintWorktrees, resolveSprintRepository, run, sprintPilotBranchName, sprintPilotTicketTail, sprintPilotWorktreeAddArgs, sprintRepositoryForWorktree } from "@/lib/sprintpilot-server";
import { forgetWorktreeLink, persistedWorktreeLinks, persistedWorktreeRepositories, persistWorktreeLink } from "@/lib/sprintpilot-worktree-links";

type WorktreeEntry = { key: string; worktree: string; branch?: string; repoRoot: string };

const sourceDefinitions = () => {
  const primary = configuredRepoRoot();
  const gitRoot = dirname(primary);
  return [
    { id: "arnac", label: "ARNAC", path: primary },
    { id: "fordicode", label: "FORDICODE", path: join(gitRoot, "fordicode") },
    { id: "workflows", label: "WORKFLOWS", path: join(gitRoot, "workflows") },
  ];
};

async function sourceRepository(source?: unknown, repoRoot?: unknown) {
  if (repoRoot !== undefined) return resolveSprintRepository(repoRoot);
  const definition = sourceDefinitions().find((candidate) => candidate.id === source);
  if (!definition) throw new Error("Choose Arnac, Fordicode, Workflows, or another Git repository");
  return resolveSprintRepository(definition.path);
}

async function discoverRepositories() {
  const candidates = [...sourceDefinitions().map((source) => source.path), ...persistedWorktreeRepositories()];
  const repositories = new Set<string>();
  for (const candidate of candidates) {
    try { repositories.add(await resolveSprintRepository(candidate)); } catch { /* Ignore missing or stale source repositories. */ }
  }
  return [...repositories];
}

function isInside(root: string, path: string) {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function matchesJiraKey(key: string, worktree: string, branch?: string) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^A-Z0-9])${escaped}(?!\\d)`, "i").test(`${basename(worktree)} ${branch || ""}`);
}

function jiraKeyFromWorktree(worktree: string, branch?: string) {
  return `${basename(worktree)} ${branch || ""}`.match(/(?:^|[^A-Z0-9])([A-Z][A-Z0-9]+-\d+)(?!\d)/i)?.[1].toUpperCase();
}

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    if (params.has("sources")) {
      const sources = await Promise.all(sourceDefinitions().map(async (source) => {
        try { return { ...source, path: await resolveSprintRepository(source.path), available: true }; }
        catch { return { ...source, available: false }; }
      }));
      return NextResponse.json({ sources });
    }
    const repositories = await discoverRepositories();
    const requestedKey = params.get("key")?.toUpperCase();
    if (requestedKey) {
      if (!/^[A-Z][A-Z0-9]+-\d+$/.test(requestedKey)) throw new Error("A valid Jira key is required");
      const candidates = (await Promise.all(repositories.map(async (repo) => {
        const registered = await registeredSprintWorktrees(repo);
        return [...registered.entries()].flatMap(([worktree, branch]): WorktreeEntry[] =>
          worktree !== repo && isInside(dirname(repo), worktree) && matchesJiraKey(requestedKey, worktree, branch)
            ? [{ key: requestedKey, worktree, branch, repoRoot: repo }]
            : []
        );
      }))).flat().sort((left, right) => Number(!left.branch) - Number(!right.branch) || left.worktree.localeCompare(right.worktree));
      return NextResponse.json({ candidates });
    }
    const discovered = (await Promise.all(repositories.map(async (repo) => {
      const registered = await registeredSprintWorktrees(repo);
      return [...registered.entries()].flatMap(([worktree, branch]): WorktreeEntry[] => {
        if (worktree === repo || !isInside(dirname(repo), worktree)) return [];
        const key = jiraKeyFromWorktree(worktree, branch);
        if (!key) return [];
        allowFileRoot(worktree);
        return [{ key, worktree, branch, repoRoot: repo }];
      });
    }))).flat();
    const byKey = new Map(discovered.map((entry) => [entry.key, entry]));
    for (const repo of repositories) {
      const registered = await registeredSprintWorktrees(repo);
      for (const [key, linkedPath] of persistedWorktreeLinks(repo)) {
        let worktree: string;
        try { worktree = realpathSync(linkedPath); } catch { continue; }
        if (worktree === repo || !isInside(dirname(repo), worktree) || !registered.has(worktree)) continue;
        const branch = registered.get(worktree);
        if (!matchesJiraKey(key, worktree, branch)) continue;
        allowFileRoot(worktree);
        byKey.set(key, { key, worktree, branch, repoRoot: repo });
      }
    }
    return NextResponse.json({ worktrees: [...byKey.values()] });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json() as { key?: string; cwd?: string };
    const key = String(body.key || "").toUpperCase();
    if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) throw new Error("A valid Jira key is required");
    const worktree = await assertSprintWorktree(body.cwd);
    const repo = await sprintRepositoryForWorktree(worktree);
    if (worktree === repo || !isInside(dirname(repo), worktree)) throw new Error("Worktree must be located under ~/git");
    const branch = (await registeredSprintWorktrees(repo)).get(worktree);
    if (!matchesJiraKey(key, worktree, branch)) throw new Error(`Worktree does not match ${key}`);
    persistWorktreeLink(repo, key, worktree);
    allowFileRoot(worktree);
    return NextResponse.json({ worktree, branch });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { key?: string; summary?: string; source?: string; repoRoot?: string };
    const key = String(body.key || "").toUpperCase();
    if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) throw new Error("A valid Jira key is required");
    const repo = await sourceRepository(body.source, body.repoRoot);
    const summary = String(body.summary || "task");
    const requestedBranch = sprintPilotBranchName(key, summary);
    const localBranches = (await run("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], repo)).split("\n").filter(Boolean);
    const retainedBranch = matchingSprintPilotBranch(localBranches, requestedBranch);
    const branch = retainedBranch || requestedBranch;
    const ticketTail = retainedBranch?.replace(/^nir\//, "") || sprintPilotTicketTail(key, summary);
    const worktree = join(dirname(repo), `${basename(repo)}-${ticketTail}`);
    if (existsSync(worktree)) {
      const existing = await assertSprintWorktree(worktree);
      const existingRepo = await sprintRepositoryForWorktree(existing);
      if (existingRepo !== repo) throw new Error(`Directory already belongs to another repository: ${worktree}`);
      const existingBranch = await run("git", ["branch", "--show-current"], existing);
      persistWorktreeLink(realpathSync(repo), key, existing);
      allowFileRoot(existing);
      return NextResponse.json({ worktree: existing, branch: existingBranch || branch, repoRoot: repo, source: basename(repo) });
    }
    await run("git", ["fetch", "origin", "main"], repo);
    const reusedBranch = Boolean(retainedBranch);
    await run("git", sprintPilotWorktreeAddArgs(branch, worktree, reusedBranch), repo);
    persistWorktreeLink(realpathSync(repo), key, realpathSync(worktree));
    allowFileRoot(worktree);
    return NextResponse.json({ worktree, branch, repoRoot: repo, source: basename(repo), reusedBranch });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json() as { cwd?: string };
    const worktree = await assertSprintWorktree(body.cwd);
    const repo = await sprintRepositoryForWorktree(worktree);
    if (worktree === repo) throw new Error("The primary repository cannot be deleted");
    await run("git", ["worktree", "remove", "--", worktree], repo);
    await run("git", ["worktree", "prune"], repo);
    forgetWorktreeLink(realpathSync(repo), worktree);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

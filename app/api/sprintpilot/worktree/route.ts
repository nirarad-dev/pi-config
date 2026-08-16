import { existsSync, realpathSync } from "fs";
import { basename, dirname, isAbsolute, join, relative } from "path";
import { NextResponse } from "next/server";
import { allowFileRoot } from "@/lib/file-access";
import { assertSprintWorktree, configuredRepoRoot, registeredSprintWorktrees, run } from "@/lib/sprintpilot-server";
import { forgetWorktreeLink, persistedWorktreeLinks, persistWorktreeLink } from "@/lib/sprintpilot-worktree-links";

type WorktreeEntry = { key: string; worktree: string; branch?: string };

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
    const repo = realpathSync(configuredRepoRoot());
    const registered = await registeredSprintWorktrees();
    const requestedKey = new URL(request.url).searchParams.get("key")?.toUpperCase();
    if (requestedKey) {
      if (!/^[A-Z][A-Z0-9]+-\d+$/.test(requestedKey)) throw new Error("A valid Jira key is required");
      const gitRoot = dirname(repo);
      const candidates = [...registered.entries()].flatMap(([worktree, branch]): WorktreeEntry[] =>
        worktree !== repo && isInside(gitRoot, worktree) && matchesJiraKey(requestedKey, worktree, branch)
          ? [{ key: requestedKey, worktree, branch }]
          : []
      ).sort((left, right) => Number(!left.branch) - Number(!right.branch) || left.worktree.localeCompare(right.worktree));
      return NextResponse.json({ candidates });
    }
    const discovered = [...registered.entries()].flatMap(([worktree, branch]): WorktreeEntry[] => {
      if (worktree === repo || !isInside(dirname(repo), worktree)) return [];
      const key = jiraKeyFromWorktree(worktree, branch);
      if (!key) return [];
      allowFileRoot(worktree);
      return [{ key, worktree, branch }];
    });
    const byKey = new Map(discovered.map((entry) => [entry.key, entry]));
    for (const [key, linkedPath] of persistedWorktreeLinks(repo)) {
      let worktree: string;
      try { worktree = realpathSync(linkedPath); } catch { continue; }
      if (worktree === repo || !isInside(dirname(repo), worktree) || !registered.has(worktree)) continue;
      const branch = registered.get(worktree);
      if (!matchesJiraKey(key, worktree, branch)) continue;
      allowFileRoot(worktree);
      byKey.set(key, { key, worktree, branch });
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
    const repo = realpathSync(configuredRepoRoot());
    if (worktree === repo || !isInside(dirname(repo), worktree)) throw new Error("Worktree must be located under ~/git");
    const branch = (await registeredSprintWorktrees()).get(worktree);
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
    const body = await request.json() as { key?: string; summary?: string };
    const key = String(body.key || "").toUpperCase();
    if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) throw new Error("A valid Jira key is required");
    const slug = String(body.summary || "task").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 42) || "task";
    const repo = configuredRepoRoot();
    const branch = `nir/${key}-${slug}`;
    const worktree = join(dirname(repo), `${basename(repo)}-${key}`);
    if (existsSync(worktree)) {
      const existing = await assertSprintWorktree(worktree);
      const existingBranch = await run("git", ["branch", "--show-current"], existing);
      persistWorktreeLink(realpathSync(repo), key, existing);
      allowFileRoot(existing);
      return NextResponse.json({ worktree: existing, branch: existingBranch || branch });
    }
    await run("git", ["fetch", "origin", "main"], repo);
    await run("git", ["worktree", "add", "--no-track", "-b", branch, worktree, "origin/main"], repo);
    persistWorktreeLink(realpathSync(repo), key, realpathSync(worktree));
    allowFileRoot(worktree);
    return NextResponse.json({ worktree, branch });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json() as { cwd?: string };
    const worktree = await assertSprintWorktree(body.cwd);
    const repo = configuredRepoRoot();
    if (worktree === repo) throw new Error("The primary repository cannot be deleted");
    await run("git", ["worktree", "remove", "--", worktree], repo);
    await run("git", ["worktree", "prune"], repo);
    forgetWorktreeLink(realpathSync(repo), worktree);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

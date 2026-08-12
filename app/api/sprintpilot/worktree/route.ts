import { existsSync } from "fs";
import { basename, dirname, join } from "path";
import { NextResponse } from "next/server";
import { allowFileRoot } from "@/lib/file-access";
import { assertSprintWorktree, configuredRepoRoot, run } from "@/lib/sprintpilot-server";

type WorktreeEntry = { key: string; worktree: string; branch?: string };

export async function GET() {
  try {
    const repo = configuredRepoRoot();
    const output = await run("git", ["worktree", "list", "--porcelain"], repo);
    const prefix = `${basename(repo)}-`;
    const worktrees = output.split(/\n\n+/).flatMap((block): WorktreeEntry[] => {
      const lines = block.split("\n");
      const worktree = lines.find((line) => line.startsWith("worktree "))?.slice(9);
      const branch = lines.find((line) => line.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "");
      if (!worktree || !basename(worktree).startsWith(prefix)) return [];
      const key = basename(worktree).slice(prefix.length).toUpperCase();
      if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) return [];
      allowFileRoot(worktree);
      return [{ key, worktree, branch }];
    });
    return NextResponse.json({ worktrees });
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
      const existingBranch = await run("git", ["branch", "--show-current"], worktree);
      allowFileRoot(worktree);
      return NextResponse.json({ worktree, branch: existingBranch || branch });
    }
    await run("git", ["fetch", "origin", "main"], repo);
    await run("git", ["worktree", "add", "--no-track", "-b", branch, worktree, "origin/main"], repo);
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
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

import { NextResponse } from "next/server";
import { getGitStatus } from "@/lib/git-changes";
import { assertSprintWorktree } from "@/lib/sprintpilot-server";

export const dynamic = "force-dynamic";

const MAX_WORKTREES = 25;

export type SprintPilotPendingChanges = { changed: number; staged: number };

/**
 * Report uncommitted work per worktree so the sprint rail can flag tasks that
 * are waiting for review and commit. Batched deliberately: the rail polls this
 * for every open task, and one request per worktree would spawn a git process
 * per task on every tick.
 */
export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("worktrees") || "";
  const worktrees = [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))];
  if (worktrees.length > MAX_WORKTREES) {
    return NextResponse.json({ error: "Too many worktrees requested" }, { status: 400 });
  }

  const entries = await Promise.all(worktrees.map(async (worktree) => {
    try {
      const cwd = await assertSprintWorktree(worktree);
      const status = await getGitStatus(cwd);
      const staged = status.files.filter((file) => file.indexStatus && !" ?".includes(file.indexStatus)).length;
      return [worktree, { changed: status.files.length, staged }] as const;
    } catch {
      // A worktree the user deleted or that failed the sprint guard simply has
      // nothing to report; it must not fail the whole rail's poll.
      return undefined;
    }
  }));

  return NextResponse.json({ pending: Object.fromEntries(entries.filter((entry) => entry !== undefined)) });
}

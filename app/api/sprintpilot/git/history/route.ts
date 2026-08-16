import { NextResponse } from "next/server";
import { parseSprintPilotGitHistory, SPRINTPILOT_GIT_HISTORY_FORMAT } from "@/lib/sprintpilot-git-history";
import { assertSprintWorktree, run } from "@/lib/sprintpilot-server";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const cwd = await assertSprintWorktree(params.get("cwd"));
    const skip = Math.max(0, Number.parseInt(params.get("skip") || "0", 10) || 0);
    const limit = Math.min(500, Math.max(50, Number.parseInt(params.get("limit") || "200", 10) || 200));
    const [output, countOutput] = await Promise.all([
      run("git", [
        "log", "--all", "--graph", "--topo-order", "--decorate=short",
        `--skip=${skip}`, `--max-count=${limit}`,
        `--pretty=format:${SPRINTPILOT_GIT_HISTORY_FORMAT}`,
      ], cwd),
      run("git", ["rev-list", "--all", "--count"], cwd),
    ]);
    const lines = parseSprintPilotGitHistory(output);
    const commitCount = lines.filter((line) => line.kind === "commit").length;
    const totalCommitCount = Number.parseInt(countOutput, 10) || commitCount;
    return NextResponse.json({ lines, commitCount, totalCommitCount, hasMore: skip + commitCount < totalCommitCount });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

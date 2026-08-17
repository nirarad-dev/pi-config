import { basename } from "path";
import { NextResponse } from "next/server";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { generateSprintPilotPullRequestMetadata } from "@/lib/sprintpilot-pr-metadata";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { assertSprintWorktree, run, sprintRepositoryForWorktree } from "@/lib/sprintpilot-server";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { cwd?: string; sessionId?: string; taskKey?: string; summary?: string; taskDescription?: string };
    const cwd = await assertSprintWorktree(body.cwd);
    if (!body.sessionId || !body.taskKey || !body.summary) throw new Error("Open the task chat before generating PR metadata");
    const sessionPath = await resolveSessionPath(body.sessionId);
    if (!sessionPath) throw new Error("The task chat no longer exists. Open it again and retry.");
    const existing = getRpcSession(body.sessionId);
    const { session } = existing?.isAlive() ? { session: existing } : await startRpcSession(body.sessionId, sessionPath, undefined);
    await session.waitUntilReady?.();
    const patch = await run("git", ["diff", "--no-ext-diff", "origin/main...HEAD"], cwd);
    const repo = basename(await sprintRepositoryForWorktree(cwd));
    const component = repo === "workflows" || /(?:^|\/)automation(?:\/|$)|\.github\/workflows\//.test(patch) ? "Automation" : repo.slice(0, 1).toUpperCase() + repo.slice(1);
    const metadata = await generateSprintPilotPullRequestMetadata(session.inner as unknown as AgentSession, {
      component, taskKey: body.taskKey, summary: body.summary, taskDescription: body.taskDescription, patch,
    });
    return NextResponse.json(metadata);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

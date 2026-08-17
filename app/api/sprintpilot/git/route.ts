import { NextResponse } from "next/server";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { buildSprintPilotCommitMessage } from "@/lib/sprintpilot-commit-message";
import { generateSprintPilotCommitMessage } from "@/lib/sprintpilot-commit-metadata";
import { checkSprintPilotPullRequestInJira } from "@/lib/sprintpilot-jira-links";
import { appendArnacAiDisclosure, sprintPilotJiraUrl } from "@/lib/sprintpilot-pr-metadata";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { assertSprintWorktree, createApproval, readApproval, run, snapshotChanges, takeApproval } from "@/lib/sprintpilot-server";

function jiraKeyFromBranch(branch: string) {
  return branch.match(/(?:^|\/)([A-Z][A-Z0-9]+-\d+)(?:-|$)/)?.[1];
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action || "");
    const cwd = await assertSprintWorktree(body.cwd);

    if (action === "commit-message") {
      const existingApproval = body.approvalToken ? readApproval(body.approvalToken) : undefined;
      if (existingApproval && existingApproval.cwd !== cwd) throw new Error("Approval belongs to another worktree");
      const approved = existingApproval
        ? { files: existingApproval.files, hash: existingApproval.hash, token: String(body.approvalToken) }
        : await (async () => {
          const snapshot = await snapshotChanges(cwd, body.files);
          return { ...snapshot, token: createApproval(cwd, snapshot.files, snapshot.hash) };
        })();
      const current = await snapshotChanges(cwd, approved.files);
      if (current.hash !== approved.hash) throw new Error("Changes moved since approval; review and draft the commit message again");
      const [patch, recentLog] = await Promise.all([
        run("git", ["diff", "--no-ext-diff", "HEAD", "--", ...approved.files], cwd),
        run("git", ["log", "-n", "10", "--no-merges", "--format=%s"], cwd).catch(() => ""),
      ]);
      const recentSubjects = recentLog.split("\n").map((subject) => subject.trim()).filter(Boolean);
      const fallback = buildSprintPilotCommitMessage(String(body.title || ""), approved.files, patch);
      if (!body.sessionId || !body.taskKey || !body.summary) return NextResponse.json({ message: fallback, approvalToken: approved.token, generatedBy: "fallback" });
      try {
        const sessionPath = await resolveSessionPath(String(body.sessionId));
        if (!sessionPath) throw new Error("The task chat no longer exists");
        const existing = getRpcSession(String(body.sessionId));
        const { session } = existing?.isAlive() ? { session: existing } : await startRpcSession(String(body.sessionId), sessionPath, undefined);
        await session.waitUntilReady?.();
        const draft = await generateSprintPilotCommitMessage(session.inner as unknown as AgentSession, {
          taskKey: String(body.taskKey), summary: String(body.summary), taskDescription: typeof body.taskDescription === "string" ? body.taskDescription : undefined,
          files: approved.files, patch, recentSubjects, fallback,
        });
        return NextResponse.json({ ...draft, approvalToken: approved.token });
      } catch (error) {
        // A draft should remain available if the model is offline, times out, or its chat expired.
        // Report why, so a silent fallback is never mistaken for the model's best effort.
        return NextResponse.json({
          message: fallback,
          approvalToken: approved.token,
          generatedBy: "fallback",
          fallbackReason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (action === "commit") {
      const approval = takeApproval(body.approvalToken);
      if (approval.cwd !== cwd) throw new Error("Approval belongs to another worktree");
      const current = await snapshotChanges(cwd, approval.files);
      if (current.hash !== approval.hash) throw new Error("Changes moved since approval; review and approve them again");
      const message = String(body.message || "").trim();
      if (!message) throw new Error("Commit message is required");
      await run("git", ["add", "--", ...approval.files], cwd);
      const output = await run("git", ["commit", "--only", "-m", message, "--", ...approval.files], cwd);
      return NextResponse.json({ success: true, output });
    }

    if (action === "push") {
      const branch = (await run("git", ["branch", "--show-current"], cwd)).trim();
      if (!branch) throw new Error("Cannot push a detached HEAD");
      const taskKey = jiraKeyFromBranch(branch);
      if (!taskKey) throw new Error("Branch must contain its Jira key before push (for example, nir/DEV-12345-short-title)");
      const output = await run("git", ["push", "--set-upstream", "origin", branch], cwd);
      return NextResponse.json({ success: true, output, branch, taskKey });
    }

    if (action === "pr") {
      const title = String(body.title || "").trim();
      const description = String(body.description || "").trim();
      if (!title) throw new Error("PR title is required");
      const titleTicket = title.match(/^\[[A-Z][^\]\r\n]+\]\s+\[(DEV-\d+)\]\s+\S/);
      if (!titleTicket) throw new Error("PR title must use the repository format: [Component] [DEV-12345] Short description");
      const branch = (await run("git", ["branch", "--show-current"], cwd)).trim();
      const branchTicket = jiraKeyFromBranch(branch);
      if (branchTicket !== titleTicket[1]) throw new Error(`PR title Jira key ${titleTicket[1]} must match branch Jira key ${branchTicket || "(missing)"}`);
      if (!description || !description.includes("## Description") || !description.includes("## Tickets")) {
        throw new Error("PR description must include Description and Tickets sections");
      }
      const ticketLink = `[${titleTicket[1]}](${sprintPilotJiraUrl(titleTicket[1])})`;
      if (!description.includes(ticketLink)) throw new Error("PR Tickets must link to the Jira issue that appears in the title");
      const bodyText = appendArnacAiDisclosure(description);
      const args = ["pr", "create", "--assignee", "@me", "--title", title, "--body", bodyText];
      if (body.draft === true) args.push("--draft");
      const output = await run("gh", args, cwd);
      const url = output.split(/\s+/).find((value) => value.startsWith("http")) || output;
      const jiraDevelopment = await checkSprintPilotPullRequestInJira(titleTicket[1]);
      return NextResponse.json({ success: true, url, draft: body.draft === true, jiraDevelopment });
    }

    throw new Error("Unknown git action");
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

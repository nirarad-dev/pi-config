import { NextResponse } from "next/server";
import { assertSprintWorktree, createApproval, run, snapshotChanges, takeApproval } from "@/lib/sprintpilot-server";

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action || "");
    const cwd = await assertSprintWorktree(body.cwd);

    if (action === "approve") {
      const snapshot = await snapshotChanges(cwd, body.files);
      return NextResponse.json({ approvalToken: createApproval(cwd, snapshot.files, snapshot.hash), hash: snapshot.hash });
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
      const output = await run("git", ["push", "--set-upstream", "origin", branch], cwd);
      return NextResponse.json({ success: true, output, branch });
    }

    if (action === "pr") {
      const title = String(body.title || "").trim();
      const description = String(body.description || "").trim();
      if (!title) throw new Error("PR title is required");
      const bodyText = description || "Created with SprintPilot and Pi. AI assistance used; all changes were explicitly reviewed and approved by the author.";
      const args = ["pr", "create", "--title", title, "--body", bodyText];
      if (body.draft === true) args.push("--draft");
      const output = await run("gh", args, cwd);
      return NextResponse.json({ success: true, url: output.split(/\s+/).find((value) => value.startsWith("http")) || output, draft: body.draft === true });
    }

    throw new Error("Unknown git action");
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

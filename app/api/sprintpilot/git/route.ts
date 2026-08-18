import { NextResponse } from "next/server";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { buildSprintPilotCommitMessage } from "@/lib/sprintpilot-commit-message";
import { generateSprintPilotCommitMessage } from "@/lib/sprintpilot-commit-metadata";
import { checkSprintPilotPullRequestInJira, createSprintPilotJiraRemoteLink } from "@/lib/sprintpilot-jira-links";
import { findInjectedJiraFooters, findStrayJiraKeys, hasBareJiraKey, ticketsSection } from "@/lib/sprintpilot-jira-keys";
import { appendArnacAiDisclosure } from "@/lib/sprintpilot-pr-metadata";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { assertSprintWorktree, changedPaths, createApproval, readApproval, releaseApproval, run, snapshotChanges, stagedAndUnstaged } from "@/lib/sprintpilot-server";

function jiraKeyFromBranch(branch: string) {
  return branch.match(/(?:^|\/)([A-Z][A-Z0-9]+-\d+)(?:-|$)/)?.[1];
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action || "");
    const cwd = await assertSprintWorktree(body.cwd);

    if (action === "status") {
      return NextResponse.json(await stagedAndUnstaged(cwd));
    }

    if (action === "stage" || action === "unstage") {
      const files = Array.isArray(body.files) ? body.files.map(String) : [];
      if (!files.length) throw new Error("Select at least one file");
      // Only paths Git reports as changed may be staged. Without this a crafted
      // request could name any ignored path — a local .env, a credentials file —
      // and the force below would put it in the index.
      const changed = await changedPaths(cwd);
      const unknown = files.filter((file) => !changed.has(file));
      if (unknown.length) throw new Error(`Git does not report these files as changed: ${unknown.join(", ")}`);

      if (action === "unstage") {
        await run("git", ["restore", "--staged", "--", ...files], cwd);
        return NextResponse.json({ success: true, ...(await stagedAndUnstaged(cwd)) });
      }
      // A tracked file inside a directory matched by .gitignore cannot be staged
      // without -f (arnac's root `env/` virtualenv rule catches
      // automation/config/env this way). Forcing silently would also let a
      // genuinely ignored file in, so the force is the operator's explicit
      // choice: the first attempt reports back, and the retry carries `force`.
      try {
        await run("git", ["add", ...(body.force === true ? ["-f"] : []), "--", ...files], cwd);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/ignored by one of your \.gitignore files/i.test(message)) {
          return NextResponse.json({
            ignored: true,
            files,
            error: `${files.length === 1 ? "That path is" : "Those paths are"} matched by a .gitignore rule. Stage anyway?`,
          }, { status: 409 });
        }
        throw error;
      }
      return NextResponse.json({ success: true, ...(await stagedAndUnstaged(cwd)) });
    }

    if (action === "commit-message") {
      // The staged set is the commit, so it is read from Git rather than taken
      // from the request. The operator curated it with the stage/unstage
      // controls; the client has nothing to add and cannot widen it.
      const { staged } = await stagedAndUnstaged(cwd);
      if (!staged.length) throw new Error("Stage at least one file before drafting a commit message");
      const snapshot = await snapshotChanges(cwd, staged);
      const approved = { ...snapshot, token: createApproval(cwd, snapshot.files, snapshot.hash) };
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
      const approval = readApproval(body.approvalToken);
      if (approval.cwd !== cwd) throw new Error("Approval belongs to another worktree");
      const { staged } = await stagedAndUnstaged(cwd);
      // The index is what gets committed, so verify the index still holds
      // exactly what was reviewed. Staging or unstaging a file after drafting
      // the message would otherwise commit something the message never described.
      if (staged.join("\n") !== approval.files.join("\n")) {
        throw new Error("The staged files changed since you reviewed them; draft the commit message again to describe what is staged now");
      }
      const current = await snapshotChanges(cwd, approval.files);
      if (current.hash !== approval.hash) throw new Error("The staged files changed since you reviewed them; draft the commit message again to pick up the new content");
      const message = String(body.message || "").trim();
      if (!message) throw new Error("Commit message is required");
      // Commits the index itself. Nothing is staged here: the operator already
      // staged exactly what they want through the review panel, and re-adding
      // would silently absorb later edits the drafted message never covered.
      const output = await run("git", ["commit", "-m", message], cwd);
      // Released only now that the commit exists. A failure above leaves the
      // approval intact so the operator can fix the cause and retry without
      // re-approving a selection they never changed.
      releaseApproval(body.approvalToken);
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

    if (action === "jira-development") {
      // Ingest is asynchronous, so the client polls this rather than the create
      // call pretending to know the answer the moment the PR exists.
      const taskKey = String(body.taskKey || "");
      if (!/^[A-Z][A-Z0-9]*-\d+$/.test(taskKey)) throw new Error("A Jira key is required");
      return NextResponse.json({ jiraDevelopment: await checkSprintPilotPullRequestInJira(taskKey) });
    }

    if (action === "jira-nudge") {
      // A comment containing nothing but the bare key is the cheapest event
      // that makes the integration re-read the PR. Reversible and additive,
      // unlike close-and-reopen, so it is what the tool does on its own.
      const taskKey = String(body.taskKey || "");
      const url = String(body.url || "");
      if (!/^[A-Z][A-Z0-9]*-\d+$/.test(taskKey)) throw new Error("A Jira key is required");
      if (!/^https:\/\/github\.com\//.test(url)) throw new Error("A GitHub pull-request URL is required");
      await run("gh", ["pr", "comment", url, "--body", taskKey], cwd);
      return NextResponse.json({ success: true, jiraDevelopment: await checkSprintPilotPullRequestInJira(taskKey) });
    }

    if (action === "pr") {
      const title = String(body.title || "").trim();
      const description = String(body.description || "").trim();
      if (!title) throw new Error("PR title is required");
      const titleTicket = title.match(/^\[[A-Z][^\]\r\n]+\]\s+\[(DEV-\d+)\]\s+\S/);
      if (!titleTicket) throw new Error("PR title must use the repository format: [Component] [DEV-12345] Short description");
      const taskKey = titleTicket[1];
      const branch = (await run("git", ["branch", "--show-current"], cwd)).trim();
      const branchTicket = jiraKeyFromBranch(branch);
      if (branchTicket !== taskKey) throw new Error(`PR title Jira key ${taskKey} must match branch Jira key ${branchTicket || "(missing)"}`);

      // Any LETTER-NUMBER token is a candidate key to the integration, so a
      // slug like `latest-release-1` offers RELEASE-1 beside the real ticket
      // and the association can land on the wrong one. Title and branch are the
      // two surfaces it scrapes; the description may say what it likes.
      const strayInTitle = findStrayJiraKeys(title, [taskKey]);
      const strayInBranch = findStrayJiraKeys(branch, [taskKey]);
      if (strayInTitle.length || strayInBranch.length) {
        const where = [
          strayInTitle.length ? `title (${strayInTitle.join(", ")})` : "",
          strayInBranch.length ? `branch (${strayInBranch.join(", ")})` : "",
        ].filter(Boolean).join(" and ");
        throw new Error(`Remove the issue-key lookalikes from the ${where}. GitHub for Jira reads every LETTER-NUMBER token, so these compete with ${taskKey}. Reword them, for example latest_release_minus_1.`);
      }

      if (!description || !description.includes("## Description")) throw new Error("PR description must include a Description section");
      const tickets = ticketsSection(description);
      if (tickets === undefined) throw new Error("PR description must include a Tickets section");
      // Bare, not merely linked: a key that exists only as a Markdown link
      // target is the shape that produced a PR Jira never showed.
      if (!hasBareJiraKey(tickets, taskKey)) {
        throw new Error(`The Tickets section must contain ${taskKey} as bare text. A Markdown link alone is not read by GitHub for Jira.`);
      }
      const injected = findInjectedJiraFooters(description);
      if (injected.length) {
        throw new Error("Remove the atlOrigin reference footer from the description. GitHub for Jira adds that itself after ingest; authoring one only imitates a PR it has already processed.");
      }

      const bodyText = appendArnacAiDisclosure(description);
      const args = ["pr", "create", "--assignee", "@me", "--title", title, "--body", bodyText];
      if (body.draft === true) args.push("--draft");
      const output = await run("gh", args, cwd);
      const url = output.split(/\s+/).find((value) => value.startsWith("http")) || output;

      // The third scraped surface. Branch and title were checked before the PR
      // existed; a commit is history and cannot be repaired from here, so it is
      // reported rather than fixed.
      const commitLog = await run("git", ["log", "--format=%s%n%b", "origin/main..HEAD"], cwd).catch(() => "");
      const commitCarriesKey = hasBareJiraKey(commitLog, taskKey);

      const [remoteLink, jiraDevelopment] = await Promise.all([
        createSprintPilotJiraRemoteLink(taskKey, url, title),
        checkSprintPilotPullRequestInJira(taskKey),
      ]);
      return NextResponse.json({
        success: true,
        url,
        draft: body.draft === true,
        taskKey,
        jiraDevelopment,
        remoteLink,
        commitCarriesKey,
      });
    }

    throw new Error("Unknown git action");
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

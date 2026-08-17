/**
 * SprintPilot pi extension.
 *
 * Turns SprintPilot's documented safety boundary into an enforced one. Until
 * this existed, SPRINTPILOT.md promised that "agent prompts explicitly prohibit
 * staging, committing, pushing" while task agents were created with pi's full
 * tool set — the boundary was a sentence in a prompt, addressed to the same
 * model it was meant to restrain.
 *
 * The extension is inert outside a SprintPilot worktree, so it is safe to load
 * for every pi-web session. Inside one it:
 *   - blocks Git and GitHub write commands from `bash`, and writes into `.git`
 *   - registers the SprintPilot workflow steps as slash commands
 *   - reports the guard in the status line
 *
 * Loaded by `lib/rpc-manager.ts` through `additionalExtensionPaths`, so it
 * needs no entry in `~/.pi/agent/extensions` and never runs from the reviewed
 * repository's own `.pi/extensions`.
 */
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { inspectSprintPilotCommand, inspectSprintPilotPath } from "../../lib/sprintpilot-git-guard";
import { SPRINTPILOT_WORKFLOW_PROMPTS } from "../../lib/sprintpilot-workflow-prompts";

const execFileAsync = promisify(execFile);

function configuredRepoRoot(): string | undefined {
  const configured = process.env.SPRINTPILOT_REPO_ROOT;
  return configured ? resolve(configured) : undefined;
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: { ...process.env, LC_ALL: "C" } });
  return stdout.trim();
}

/**
 * A SprintPilot worktree is a *linked* worktree — its git common directory
 * lives in another repository. Checking the link rather than a path prefix
 * means the guard follows worktrees wherever the operator puts them, and never
 * fires on the main checkout, where ordinary Git work is expected.
 */
async function isSprintPilotWorktree(cwd: string): Promise<boolean> {
  try {
    const real = realpathSync(cwd);
    const top = realpathSync(await git(["rev-parse", "--show-toplevel"], real));
    if (top !== real) return false;
    const commonDirectory = await git(["rev-parse", "--git-common-dir"], real);
    const commonPath = realpathSync(isAbsolute(commonDirectory) ? commonDirectory : resolve(real, commonDirectory));
    const mainRepository = realpathSync(dirname(commonPath));
    if (mainRepository === real) return false;
    const configured = configuredRepoRoot();
    // With no configured root, guard every linked worktree: SprintPilot's own
    // safety contract is the conservative default, and refusing to guard is the
    // failure that matters here.
    if (!configured) return true;
    return mainRepository === realpathSync(configured);
  } catch {
    // Not a repository, or git is unavailable. Nothing to guard.
    return false;
  }
}

/** Jira key carried by the branch, matching SprintPilot's branch convention. */
function jiraKeyFromBranch(branch: string): string | undefined {
  return branch.match(/(?:^|\/)([A-Z][A-Z0-9]+-\d+)(?:-|$)/)?.[1];
}

export default function sprintPilotExtension(pi: ExtensionAPI): void {
  // Keyed by cwd, resolved lazily on the first tool call. Doing it at
  // session_start would add git latency to every pi-web session start,
  // including the ones this extension never guards. Caching the promise rather
  // than the value keeps concurrent tool calls from racing on the same check,
  // and keying by cwd means a session that moves between a worktree and its
  // main checkout is judged against the directory it is actually in.
  const guarded = new Map<string, Promise<boolean>>();
  let branch = "";

  const isGuarded = (context: ExtensionContext): Promise<boolean> => {
    const cached = guarded.get(context.cwd);
    if (cached) return cached;
    const pending = isSprintPilotWorktree(context.cwd).then(async (isWorktree) => {
      if (isWorktree) {
        branch = await git(["branch", "--show-current"], context.cwd).catch(() => "");
        context.ui.setStatus("sprintpilot", `SPRINTPILOT GUARD${branch ? ` ${branch}` : ""}`);
      }
      return isWorktree;
    });
    guarded.set(context.cwd, pending);
    return pending;
  };

  pi.on("tool_call", async (event, context) => {
    if (event.toolName !== "bash" && event.toolName !== "write" && event.toolName !== "edit") return;
    if (!(await isGuarded(context))) return;

    if (event.toolName === "bash") {
      const command = (event.input as { command?: unknown }).command;
      if (typeof command !== "string") return;
      const verdict = inspectSprintPilotCommand(command);
      return verdict.blocked ? { block: true, reason: verdict.reason } : undefined;
    }

    const input = event.input as { path?: unknown; file_path?: unknown };
    const path = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : undefined;
    if (!path) return;
    const verdict = inspectSprintPilotPath(path);
    return verdict.blocked ? { block: true, reason: verdict.reason } : undefined;
  });

  for (const [step, prompt] of Object.entries(SPRINTPILOT_WORKFLOW_PROMPTS)) {
    pi.registerCommand(prompt.command, {
      description: prompt.description,
      handler: async (args, context) => {
        const currentBranch = branch || await git(["branch", "--show-current"], context.cwd).catch(() => "");
        const key = jiraKeyFromBranch(currentBranch);
        if (!key) {
          context.ui.notify(`/${prompt.command} needs a Jira key in the branch name (for example nir/DEV-12345-short-title). Current branch: ${currentBranch || "(detached)"}.`, "warning");
          return;
        }
        // The branch carries the ticket key, which is what the prompts key off.
        // Any argument the operator typed becomes the summary, so
        // `/sp-plan add retry to the signer` reads naturally in the prompt.
        pi.sendUserMessage(prompt.build({ key, summary: args.trim() || step }));
      },
    });
  }
}

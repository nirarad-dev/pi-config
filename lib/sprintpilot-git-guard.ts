/**
 * Deny-list for Git and GitHub writes inside SprintPilot worktrees.
 *
 * SPRINTPILOT.md states that staging, committing, pushing, and opening pull
 * requests stay behind explicit user actions. Until now that was enforced only
 * by prompt text in `actionPrompts`, while task agents were created without a
 * tool allow-list and therefore held pi's full `bash` tool. A model that
 * decided a commit was helpful had nothing standing in its way.
 *
 * This module is the decision half of that boundary; the SprintPilot extension
 * applies it from a `tool_call` handler, which pi lets an extension block.
 *
 * Scope, stated honestly: this is a deny-list over the command the agent asked
 * to run, not a sandbox. A determined agent can still reach git through a shell
 * indirection this list does not model (a user-defined alias, a script that
 * shells out, a here-doc fed to `sh`). It is defense in depth that makes the
 * documented boundary real for every straightforward path, and it is strictly
 * better than the prompt-only guard it replaces. The approval-token flow in
 * `sprintpilot-server.ts` remains the authority for writes SprintPilot itself
 * performs.
 */

/** Git subcommands that mutate the index, history, stash, or a remote. */
const BLOCKED_GIT_SUBCOMMANDS = new Set([
  "add", "commit", "push", "stash", "rm", "mv", "reset", "restore",
  "cherry-pick", "revert", "rebase", "merge", "am", "apply", "update-index",
  "update-ref", "tag", "branch", "checkout", "switch", "clean", "gc", "prune",
  "filter-branch", "worktree", "submodule", "notes", "replace", "fast-import",
]);

/**
 * Read-only uses of otherwise-blocked subcommands. Agents legitimately inspect
 * branches and stashes while planning, and blocking `git branch --show-current`
 * would break SprintPilot's own workflow prompts.
 */
const READ_ONLY_GIT_FORMS: { subcommand: string; flags: RegExp }[] = [
  { subcommand: "branch", flags: /^(?:--show-current|--list|-l|-a|-r|-v|-vv|--all|--remotes|--contains|--merged|--no-merged|--format=.*|--sort=.*)$/ },
  { subcommand: "stash", flags: /^(?:list|show)$/ },
  { subcommand: "tag", flags: /^(?:-l|--list|--contains|--points-at|--sort=.*|--format=.*)$/ },
  { subcommand: "worktree", flags: /^(?:list)$/ },
  { subcommand: "submodule", flags: /^(?:status|summary)$/ },
  { subcommand: "notes", flags: /^(?:list|show)$/ },
];

/** `gh` subcommand paths that publish or mutate something outside the machine. */
const BLOCKED_GH_PATHS = [
  ["pr", "create"], ["pr", "merge"], ["pr", "close"], ["pr", "reopen"],
  ["pr", "edit"], ["pr", "ready"], ["pr", "review"], ["pr", "comment"],
  ["issue", "create"], ["issue", "close"], ["issue", "comment"], ["issue", "edit"],
  ["release", "create"], ["release", "delete"], ["release", "edit"],
  ["repo", "create"], ["repo", "delete"], ["repo", "edit"],
  ["api"], ["workflow", "run"], ["run", "cancel"], ["run", "rerun"], ["secret", "set"],
];

export type SprintPilotGuardVerdict = { blocked: false } | { blocked: true; reason: string };

/**
 * Split a shell command into the segments that each run a program.
 *
 * Quoted separators must not split — `git commit -m "a && b"` is one command,
 * and treating the quoted `&&` as a separator would produce a bogus segment.
 */
export function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote) {
      current += char;
      if (char === quote && command[index - 1] !== "\\") quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "\n" || char === ";" || char === "&" || char === "|") {
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

/** Tokenize one segment, dropping surrounding quotes so flags compare cleanly. */
function tokenize(segment: string): string[] {
  const tokens = segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  return tokens.map((token) => token.replace(/^["']|["']$/g, ""));
}

/**
 * Strip the noise that precedes the real program name: `env FOO=1`, bare
 * `FOO=1` assignments, `command`, `sudo`, and a leading path on the binary.
 */
function programAndArgs(tokens: string[]): { program: string; args: string[] } | undefined {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (/^[A-Za-z_][\w]*=/.test(token) || token === "env" || token === "command" || token === "sudo" || token === "nohup") {
      index++;
      continue;
    }
    break;
  }
  if (index >= tokens.length) return undefined;
  const program = tokens[index].split(/[\\/]/).pop() || "";
  return { program, args: tokens.slice(index + 1) };
}

/** Drop git's own pre-subcommand options, including the ones that take a value. */
function gitSubcommandAndArgs(args: string[]): { subcommand: string; rest: string[] } | undefined {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === "-C" || arg === "-c" || arg === "--git-dir" || arg === "--work-tree" || arg === "--namespace" || arg === "--exec-path") {
      index += 2;
      continue;
    }
    if (arg.startsWith("-")) {
      index++;
      continue;
    }
    break;
  }
  if (index >= args.length) return undefined;
  return { subcommand: args[index], rest: args.slice(index + 1) };
}

function gitVerdict(args: string[]): SprintPilotGuardVerdict {
  const parsed = gitSubcommandAndArgs(args);
  if (!parsed) return { blocked: false };
  const { subcommand, rest } = parsed;

  // `-a`/`--all` on commit stages every tracked file, so it is a write even
  // though `commit` is already blocked; keep the message specific.
  if (!BLOCKED_GIT_SUBCOMMANDS.has(subcommand)) {
    // `git restore` only touches the index with --staged/--source.
    return { blocked: false };
  }
  if (subcommand === "restore" && !rest.some((arg) => arg === "--staged" || arg === "-S")) {
    return { blocked: false };
  }
  const readOnly = READ_ONLY_GIT_FORMS.find((form) => form.subcommand === subcommand);
  if (readOnly && rest.length > 0 && rest.every((arg) => readOnly.flags.test(arg))) {
    return { blocked: false };
  }
  return {
    blocked: true,
    reason: `SprintPilot blocks \`git ${subcommand}\` inside a sprint worktree. Staging, committing, pushing, and history rewrites are the operator's explicit actions, taken from the SprintPilot review panel after approving an exact file list. Describe the change you want committed instead of running it.`,
  };
}

function ghVerdict(args: string[]): SprintPilotGuardVerdict {
  const path = args.filter((arg) => !arg.startsWith("-"));
  const match = BLOCKED_GH_PATHS.find((blocked) => blocked.every((part, index) => path[index] === part));
  if (!match) return { blocked: false };
  return {
    blocked: true,
    reason: `SprintPilot blocks \`gh ${match.join(" ")}\` inside a sprint worktree. Pull requests are opened from the SprintPilot review panel after push, so the title format and Jira link are validated first.`,
  };
}

/** Decide whether one bash command may run inside a SprintPilot worktree. */
export function inspectSprintPilotCommand(command: string): SprintPilotGuardVerdict {
  for (const segment of splitShellSegments(command)) {
    const parsed = programAndArgs(tokenize(segment));
    if (!parsed) continue;
    const verdict = parsed.program === "git"
      ? gitVerdict(parsed.args)
      : parsed.program === "gh"
        ? ghVerdict(parsed.args)
        : { blocked: false as const };
    if (verdict.blocked) return verdict;
  }
  return { blocked: false };
}

/** Reject edits that reach into `.git`, which would sidestep the command guard. */
export function inspectSprintPilotPath(filePath: string): SprintPilotGuardVerdict {
  return /(?:^|[\\/])\.git(?:[\\/]|$)/.test(filePath)
    ? { blocked: true, reason: "SprintPilot blocks writes inside `.git`. Repository state is changed through the review panel, not by editing Git's internals." }
    : { blocked: false };
}

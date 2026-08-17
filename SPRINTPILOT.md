# SprintPilot

SprintPilot is a local control plane built on Pi Web. It keeps every Jira issue in a separate worktree and Pi session while leaving staging, commits, pushes, and pull requests behind explicit user actions.

## Start

1. Copy `sprintpilot.env.example` to `.env.local` and fill in Jira credentials.
2. Run `npm install`.
3. Run `npm run dev`.
4. Open `http://127.0.0.1:30141`.
5. Use **Connect Claude Code** and **Connect Codex** for the one-time Pi OAuth flows.

For Codex, click **Connect Codex**, open the ChatGPT sign-in link from the dialog, approve access, and copy the entire callback URL from the browser address bar back into SprintPilot. Keep the SprintPilot dialog open while completing the browser step. Device-code providers instead show a code and wait automatically after you enter it on their verification page.

The Jira token stays on the server. Pi stores provider authorization in its normal local auth store; SprintPilot never copies credentials into browser storage.

Sprint tasks show distinct issue-type and epic icons, plus the epic key and name using Jira's current parent hierarchy. SprintPilot follows Jira pagination until every matching issue is loaded. Older company-managed projects can set `JIRA_EPIC_LINK_FIELD` to their Epic Link custom-field ID.

## Safety boundaries

- Worktrees start from freshly fetched `origin/main` with `--no-track`.
- Existing SprintPilot worktrees are rediscovered after a reload. Deleting one requires confirmation, refuses dirty worktrees, and retains the Git branch.
- The bundled `extensions/sprintpilot` pi extension blocks Git and GitHub write commands, and writes into `.git`, from the agent's `bash`, `write`, and `edit` tools. It is enforced by a `tool_call` handler, not by prompt text, and applies to any session whose cwd is a linked worktree of the SprintPilot repository — including sessions resumed later. Read-only Git (`status`, `diff`, `log`, `branch --show-current`, `stash list`) stays available.
  This is a deny-list over the requested command, not a sandbox: an indirection it does not model (a user-defined alias, a script that shells out) can still reach Git. It makes the boundary real for every direct path, and the approval-token flow below remains the authority for the writes SprintPilot itself performs.
- Agent prompts also state the prohibition, so the agent plans within the boundary instead of discovering it by hitting a block, and so the workflow prompts stay correct when used without the extension.
- A commit requires approval for an exact file list and content hash. The token expires after 30 minutes and is invalidated by changed content.
- Push is a separate action.
- Draft and ready-for-review PR creation are separate actions after push.
- Test paths are restricted to Python files under `automation/tests`.

## Automation configurations

The four presets mirror `.vscode/launch.json`: warm preprod, cold reset, cold with cached extension, and Playwright Inspector. The UI shows enabled arguments and keeps provider/nightly overrides disabled until individually selected.

## Pi extension

`extensions/sprintpilot/` is a pi extension loaded by `lib/rpc-manager.ts` through `additionalExtensionPaths`. It needs no entry in `~/.pi/agent/extensions` and never runs from the reviewed repository's own `.pi/extensions`, so opening a repository cannot execute its extension code.

It contributes:

- **The Git write guard** described under Safety boundaries. `lib/sprintpilot-git-guard.ts` holds the decision logic as pure functions, so the deny-list is unit-tested independently of pi.
- **Workflow slash commands** — `/sp-plan`, `/sp-develop`, `/sp-test`, `/sp-precommit`, `/sp-approve`, `/sp-commit`, `/sp-push`, `/sp-pr`, `/sp-deep-review`, `/sp-pr-review`. They send the same prompts the web UI queues, from `lib/sprintpilot-workflow-prompts.ts`, so the two surfaces cannot drift. The ticket key comes from the branch name; any argument becomes the summary (`/sp-plan add retry to the signer`).
- **A status entry** naming the guarded branch.

The extension is inert outside a SprintPilot worktree, which is why it is safe to load for every session. It detects a worktree by checking that the Git common directory lives in another repository, and — when `SPRINTPILOT_REPO_ROOT` is set — that the repository is the configured one.

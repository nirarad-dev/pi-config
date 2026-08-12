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
- Agent prompts explicitly prohibit staging, committing, pushing, and posting reviews.
- A commit requires approval for an exact file list and content hash. The token expires after 30 minutes and is invalidated by changed content.
- Push is a separate action.
- Draft and ready-for-review PR creation are separate actions after push.
- Test paths are restricted to Python files under `automation/tests`.

## Automation configurations

The four presets mirror `.vscode/launch.json`: warm preprod, cold reset, cold with cached extension, and Playwright Inspector. The UI shows enabled arguments and keeps provider/nightly overrides disabled until individually selected.

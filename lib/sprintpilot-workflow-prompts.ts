/**
 * The workflow-step prompts, in one place.
 *
 * Shared deliberately: the SprintPilot web UI queues these into the task chat,
 * and the SprintPilot pi extension registers the same text as slash commands so
 * the identical workflow is available from a plain `pi` session in the
 * worktree. Two copies would drift, and the copy the operator actually reached
 * would depend on which surface they opened.
 *
 * This module must stay free of Next.js and SDK imports — the extension loads
 * it from disk through jiti, outside the Next build.
 */

export type SprintPilotPromptTask = { key: string; summary: string };

export type SprintPilotWorkflowPrompt = {
  /** Slash-command name registered by the extension. */
  command: string;
  description: string;
  build: (task: SprintPilotPromptTask) => string;
};

/**
 * The "do not stage/commit/push" clauses are kept even though the extension now
 * blocks those commands outright. The block is the boundary; the sentence is
 * what stops the agent from planning around a wall it will only discover by
 * hitting it, and it still applies when these prompts are used without the
 * extension loaded.
 */
export const SPRINTPILOT_WORKFLOW_PROMPTS: Record<string, SprintPilotWorkflowPrompt> = {
  Plan: {
    command: "sp-plan",
    description: "Plan the current SprintPilot ticket without editing files",
    build: (task) => `Plan ${task.key}: ${task.summary}. Inspect the worktree and produce a phased implementation plan. Do not edit files, commit, or push.`,
  },
  Develop: {
    command: "sp-develop",
    description: "Implement the approved plan for the current ticket",
    build: (task) => `Implement ${task.key}: ${task.summary}. Follow the approved plan and repository guidance. Run focused checks, but do not stage, commit, push, or open a PR.`,
  },
  Test: {
    command: "sp-test",
    description: "Identify and run the most relevant focused tests",
    build: (task) => `Start a fresh testing session for ${task.key}: ${task.summary}. Inspect the current changes and identify or run the most relevant focused tests. Do not stage, commit, push, or open a PR.`,
  },
  "Pre-commit": {
    command: "sp-precommit",
    description: "Run the repository pre-commit checks and fix valid findings",
    build: (task) => `Review the pending changes for ${task.key} before commit. Run the repository pre-commit checks and fix valid findings, but do not stage or commit anything.`,
  },
  Approve: {
    command: "sp-approve",
    description: "Give an approval recommendation on the pending changes",
    build: (task) => `Review the pending changes for ${task.key} and provide an approval recommendation with any blocking findings. Do not stage, commit, push, or open a PR.`,
  },
  Commit: {
    command: "sp-commit",
    description: "Assess commit readiness and propose a message",
    build: (task) => `Assess commit readiness for ${task.key}, summarize the exact intended files, and propose a commit message. Do not stage or commit anything.`,
  },
  Push: {
    command: "sp-push",
    description: "Assess push readiness and branch state",
    build: (task) => `Assess push readiness for ${task.key}, including branch state and required checks. Do not push or make any Git writes.`,
  },
  "Open PR": {
    command: "sp-pr",
    description: "Draft a pull request title and description",
    build: (task) => `Prepare a pull request title and description for ${task.key} from the current changes. Do not push or open the pull request.`,
  },
  "Deep review": {
    command: "sp-deep-review",
    description: "Deep-review the pending changes and debunk every finding",
    build: (task) => `Deep-review the pending ${task.key} changes at standard depth. Pin the current head, review with structured and holistic passes, then debunk every finding. Report only validated findings. Do not post, commit, or push.`,
  },
  "PR review": {
    command: "sp-pr-review",
    description: "Run the PR-review workflow up to the approval gate",
    build: (task) => `Run the PR-review workflow for ${task.key}: intake, triage, plan, then stop for approval before executing fixes. Preserve the workflow's hard approval gates. Do not commit, push, or post review replies without explicit approval.`,
  },
};

/** Build the prompt for one workflow step, or undefined when the step has none. */
export function sprintPilotWorkflowPrompt(step: string, task: SprintPilotPromptTask): string | undefined {
  return SPRINTPILOT_WORKFLOW_PROMPTS[step]?.build(task);
}

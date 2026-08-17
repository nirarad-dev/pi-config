export type TestPreset = {
  id: string;
  name: string;
  description: string;
  args: string[];
  env?: Record<string, string>;
  optionalArgs: { id: string; label: string; args: string[] }[];
};

const providerOptions = [
  { id: "saucelabs", label: "Sauce Labs", args: ["--appium-provider=saucelabs"] },
  { id: "browserstack", label: "BrowserStack", args: ["--appium-provider=browserstack"] },
  { id: "browserstack-debug", label: "BrowserStack interactive debugging", args: ["--browserstack-interactive-debugging"] },
  { id: "nightly-build", label: "Nightly mobile app build", args: ["--mobile-app-build=nightly"] },
];

export const TEST_PRESETS: TestPreset[] = [
  {
    id: "warm-preprod",
    name: "Preprod · warm session",
    description: "Current file with local Appium and warm-login reuse.",
    args: ["--env=preprod", "--appium-provider=local", "--require-warmup-login", "-v", "-s", "--log-level=DEBUG", "--tb=long"],
    optionalArgs: providerOptions,
  },
  {
    id: "cold-reset",
    name: "Preprod · cold reset",
    description: "Current file after resetting browser state.",
    args: ["--env=preprod", "--appium-provider=local", "--require-warmup-login", "--reset-browser-state", "-v", "-s", "--log-level=DEBUG", "--tb=long"],
    optionalArgs: providerOptions,
  },
  {
    id: "cold-no-extension",
    name: "Preprod · cold, cached extension",
    description: "Reset state and skip the extension download.",
    args: ["--env=preprod", "--reset-browser-state", "--skip-extension-download", "-v", "-s", "--log-level=DEBUG", "--tb=long"],
    optionalArgs: providerOptions,
  },
  {
    id: "playwright-inspector",
    name: "Preprod · Playwright Inspector",
    description: "Cold run with PWDEBUG=1 for interactive inspection.",
    args: ["--env=preprod", "--reset-browser-state", "-v", "-s", "--log-level=DEBUG", "--tb=long"],
    env: { PWDEBUG: "1" },
    optionalArgs: providerOptions,
  },
];

export function resolveTestArgs(preset: TestPreset, optionIds: string[]): string[] {
  const remoteProviders = optionIds.filter((id) => id === "saucelabs" || id === "browserstack");
  if (remoteProviders.length > 1) throw new Error("Choose only one Appium provider override");
  const normalized = optionIds.includes("browserstack-debug") && remoteProviders.length === 0
    ? [...optionIds, "browserstack"]
    : optionIds;
  const baseArgs = normalized.some((id) => id === "saucelabs" || id === "browserstack")
    ? preset.args.filter((arg) => !arg.startsWith("--appium-provider="))
    : preset.args;
  return [...baseArgs, ...preset.optionalArgs.filter((option) => normalized.includes(option.id)).flatMap((option) => option.args)];
}

export type SprintTask = {
  key: string;
  summary: string;
  description?: string;
  status: string;
  statusCategory?: string;
  priority: string;
  issueType?: string;
  assignee?: string;
  epicKey?: string;
  epicName?: string;
  worktree?: string;
};

export type ModelEntry = { id: string; name: string; provider: string };

export const WORKFLOW_STEPS = [
  "Plan",
  "Develop",
  "Test",
  "Pre-commit",
  "Approve",
  "Commit",
  "Push",
  "Open PR",
  "Deep review",
  "PR review",
] as const;

export type WorkflowStep = (typeof WORKFLOW_STEPS)[number];

export function completedStepsForJiraStatus(status: string): WorkflowStep[] {
  const normalized = status.trim().toLowerCase();
  return normalized === "in cr" || normalized === "cr" || normalized === "code review"
    ? ["Plan", "Develop"]
    : [];
}

export function normalizeCompletedSteps(...groups: readonly string[][]): WorkflowStep[] {
  const completed = new Set(groups.flat());
  return WORKFLOW_STEPS.filter((step) => completed.has(step));
}

export type SprintTaskGroup = "cr" | "progress" | "backlog";

export const SPRINT_TASK_GROUPS: { id: SprintTaskGroup; label: string }[] = [
  { id: "cr", label: "IN CR" },
  { id: "progress", label: "IN PROGRESS" },
  { id: "backlog", label: "BACKLOG" },
];

const CR_STATUSES = /^(in cr|cr|code review|in code review|in review|review|reviewing|peer review)$/;
const IN_PROGRESS_STATUSES = /^(in progress|in development|in dev|doing|started|implementing)$/;

/** Map a Jira status name onto the three rail groups. Anything unrecognized is backlog. */
export function sprintTaskGroup(task: Pick<SprintTask, "status" | "statusCategory">): SprintTaskGroup {
  const status = task.status.trim().toLowerCase();
  if (CR_STATUSES.test(status)) return "cr";
  if (IN_PROGRESS_STATUSES.test(status)) return "progress";
  // Jira's own category is the fallback signal for custom workflow names: a
  // status the regexes do not know but that Jira classifies as in-flight is
  // far more likely to be active work than backlog.
  if (task.statusCategory?.toLowerCase() === "indeterminate") return "progress";
  return "backlog";
}

/**
 * Order the sprint rail: in CR first, then in progress, then backlog.
 *
 * Backlog is additionally clustered by epic so related work reads together;
 * within an epic, and within the two active groups, the incoming Jira order
 * (JIRA_JQL defaults to `ORDER BY Rank ASC`) is preserved.
 */
export function sortSprintTasks(tasks: readonly SprintTask[]): SprintTask[] {
  const groupOrder = new Map(SPRINT_TASK_GROUPS.map((group, index) => [group.id, index]));
  // Epics keep the order Jira first mentioned them, so the rail stays stable
  // across refreshes. Tasks with no epic sort last rather than jumping to the
  // top whenever an unparented issue happens to lead the response.
  const epicOrder = new Map<string, number>();
  tasks.forEach((task) => {
    if (task.epicKey && !epicOrder.has(task.epicKey)) epicOrder.set(task.epicKey, epicOrder.size);
  });
  const epicRank = (task: SprintTask) => task.epicKey ? epicOrder.get(task.epicKey)! : Number.MAX_SAFE_INTEGER;
  return tasks.map((task, index) => ({ task, index })).sort((left, right) => {
    const leftGroup = sprintTaskGroup(left.task);
    const rightGroup = sprintTaskGroup(right.task);
    if (leftGroup !== rightGroup) return groupOrder.get(leftGroup)! - groupOrder.get(rightGroup)!;
    if (leftGroup === "backlog") {
      const difference = epicRank(left.task) - epicRank(right.task);
      if (difference !== 0) return difference;
    }
    return left.index - right.index;
  }).map(({ task }) => task);
}

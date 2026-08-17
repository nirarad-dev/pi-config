"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/cjs/styles/prism";
import { completedStepsForJiraStatus, normalizeCompletedSteps, sortSprintTasks, SPRINT_TASK_GROUPS, sprintTaskGroup, TEST_PRESETS, WORKFLOW_STEPS, type ModelEntry, type SprintTask, type WorkflowStep } from "@/lib/sprintpilot-config";
import { sprintPilotWorkflowPrompt } from "@/lib/sprintpilot-workflow-prompts";
import { buildSprintPilotChangeTree, type SprintPilotChangeTreeNode } from "@/lib/sprintpilot-change-tree";
import { parseDiff } from "@/lib/sprintpilot-diff";
import type { SprintPilotHistoryLine } from "@/lib/sprintpilot-git-history";
import { sprintPilotDiffTokenStyles } from "@/lib/sprintpilot-highlight";
import { buildReviewFixPrompt, type ReviewComment } from "@/lib/sprintpilot-review";
import { sprintPilotDiffLanguage } from "@/lib/sprintpilot-syntax";
import type { ProviderRateLimits, SprintPilotUsage } from "@/lib/sprintpilot-usage";
import { AgentCommandError, sendAgentCommand } from "@/lib/agent-client";
import { DirectoryPicker } from "./DirectoryPicker";
import { FolderIcon, getFileIcon } from "./FileIcons";
import styles from "./SprintPilot.module.css";

const SPRINTPILOT_DIFF_THEME = { ...vscDarkPlus, ...sprintPilotDiffTokenStyles };
const HISTORY_PAGE_SIZE = 200;

type ModelResponse = {
  modelList?: ModelEntry[];
  defaultModel?: { provider: string; modelId: string } | null;
  thinkingLevels?: Record<string, string[]>;
};

type GitFile = { filePath: string; status: string; indexStatus?: string; worktreeStatus?: string };
type WorktreeCandidate = { key: string; worktree: string; branch?: string };
type WorktreeSource = { id: string; label: string; path: string; available: boolean };
type CreateWorktreeSetup = { loading: boolean; sources: WorktreeSource[]; error?: string };
type LinkSetup = {
  key: string;
  loading: boolean;
  candidates: WorktreeCandidate[];
  selected?: string;
  error?: string;
};
type AuthProvider = { id: string; name: string; loggedIn: boolean };
type AuthSetup = {
  provider: "anthropic" | "openai-codex";
  phase: "connecting" | "auth" | "device" | "prompt" | "select" | "progress" | "success" | "error";
  message?: string;
  url?: string;
  token?: string;
  userCode?: string;
  input?: string;
  options?: { id: string; label: string }[];
};
type DraftOrigin = { generatedBy?: "agent" | "repaired" | "fallback"; model?: { provider: string; id: string; fast: boolean }; fallbackReason?: string };
type CommitSetup = DraftOrigin & { phase: "loading" | "ready" | "error"; message: string; error?: string };
type PullRequestSetup = DraftOrigin & { phase: "loading" | "ready" | "error"; draft: boolean; title: string; description: string; error?: string };
type AgentAlert = "finished" | "attention";
type AgentStatusSnapshot = {
  running: boolean;
  queued: boolean;
  needsUserInput: boolean;
  lastPromptFinishedAt?: number;
  /** The agent spoke last in the transcript and has not been answered. */
  awaitingReply?: boolean;
};
type AgentRailStatus = "working" | "queued" | "needs-input" | "ready" | "idle";
type PendingChanges = { changed: number; staged: number };
type TaskRuntime = {
  worktree?: string;
  branch?: string;
  provider?: string;
  modelId?: string;
  effort?: string;
  approvalToken?: string;
  testFile?: string;
  testPreset: string;
  testOptions: string[];
  sessionId?: string;
  completed: WorkflowStep[];
  reviewComments: ReviewComment[];
};

const DEMO_TASKS: SprintTask[] = [
  { key: "DEV-4821", issueType: "Story", summary: "Harden transaction policy evaluation", status: "In Progress", priority: "High", epicKey: "DEV-4700", epicName: "Policy engine hardening" },
  { key: "DEV-4798", issueType: "Task", summary: "Add wallet recovery audit trail", status: "Selected", priority: "Medium", epicKey: "DEV-4650", epicName: "Recovery controls" },
  { key: "DEV-4762", issueType: "Bug", summary: "Fix mobile signing timeout", status: "Review", priority: "Critical", epicKey: "DEV-4720", epicName: "Mobile signing reliability" },
  { key: "DEV-4840", issueType: "Task", summary: "Expose vault health diagnostics", status: "To Do", priority: "Low", epicKey: "DEV-4800", epicName: "Operational visibility" },
];

const initialRuntime = (): TaskRuntime => ({ testPreset: TEST_PRESETS[0].id, testOptions: [], completed: [], reviewComments: [] });
const COMPLETED_STEPS_KEY = "sprintpilot-completed-steps-v1";
const AGENT_STEPS: WorkflowStep[] = ["Plan", "Develop", "Pre-commit", "Deep review", "PR review"];
const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_EFFORT = "medium";

function providerLabel(provider: string) {
  const value = provider.toLowerCase();
  if (value.includes("anthropic") || value.includes("claude")) return "Claude Code";
  if (value.includes("openai") || value.includes("codex")) return "Codex";
  return provider;
}

function agentRailStatus(snapshot: AgentStatusSnapshot | undefined, alert: AgentAlert | undefined): AgentRailStatus | undefined {
  if (!snapshot && !alert) return undefined;
  if (snapshot?.needsUserInput || alert === "attention") return "needs-input";
  if (snapshot?.queued) return "queued";
  if (snapshot?.running) return "working";
  if (alert === "finished") return "ready";
  return "idle";
}

/**
 * Say where a draft came from. A fallback draft is only the changed-file list,
 * so leaving it unlabelled made the deterministic builder look like the model's
 * best effort — the reason drafting was reported as "very simple".
 */
function DraftProvenance({ origin }: { origin: DraftOrigin }) {
  if (!origin.generatedBy) return null;
  const model = origin.model ? `${origin.model.id}${origin.model.fast ? "" : " · full coding model"}` : "unknown model";
  const detail = origin.generatedBy === "fallback"
    ? `Offline template — no model was used.${origin.fallbackReason ? ` ${origin.fallbackReason}` : ""}`
    : origin.generatedBy === "repaired"
      ? `Drafted by ${model}, ticket prefix added automatically.`
      : `Drafted by ${model}.`;
  return <p className={`${styles.draftProvenance} ${origin.generatedBy === "fallback" ? styles.draftProvenanceFallback : ""}`}>{detail}</p>;
}

const AGENT_RAIL_STATUS: Record<AgentRailStatus, { label: string; title: string }> = {
  working: { label: "WORKING", title: "The task agent is working" },
  queued: { label: "QUEUED", title: "A follow-up is queued after current agent work" },
  "needs-input": { label: "NEEDS INPUT", title: "The task agent is waiting for your input" },
  // "The agent stopped" and "the agent asked you something" are the same
  // observable state: needsUserInput only fires for extension UI dialogs, not
  // for a question the agent wrote as text. Wording this as awaiting a reply
  // covers both, and the alert stays until the operator actually replies.
  ready: { label: "AWAITING YOU", title: "The task agent finished and is waiting for your reply. This clears when you send it something." },
  idle: { label: "IDLE", title: "The task chat is open and waiting" },
};

function isDefaultModel(model: ModelEntry) {
  return model.provider === DEFAULT_PROVIDER && model.id === DEFAULT_MODEL;
}

function preferredEffort(levels: Record<string, string[]>, model: ModelEntry) {
  const supported = levels[`${model.provider}:${model.id}`] || ["off"];
  return supported.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : supported[0];
}

function RateLimitBadge({ label, limits, showFiveHour = true }: { label: string; limits?: ProviderRateLimits; showFiveHour?: boolean }) {
  const percentage = (value?: number) => value === undefined ? "—" : `${Math.round(value)}%`;
  const reset = (value?: string) => value ? new Date(value).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "No reset data";
  return <span className={`${styles.claudeUsageBadge} ${showFiveHour ? "" : styles.rateLimitWeeklyOnly}`}>
    <b>{label}</b>
    {showFiveHour && <span title={`Resets ${reset(limits?.fiveHour?.resetsAt)}`}><small>5H</small><strong>{percentage(limits?.fiveHour?.usedPercentage)}</strong></span>}
    <span title={`Resets ${reset(limits?.weekly?.resetsAt)}`}><small>WEEK</small><strong>{percentage(limits?.weekly?.usedPercentage)}</strong></span>
  </span>;
}

function HistoryGraph({ lines, hasMore, loading, onLoadMore }: { lines: SprintPilotHistoryLine[]; hasMore: boolean; loading: boolean; onLoadMore: () => void }) {
  if (!lines.length) return <div className={styles.historyEmpty}>No commits are reachable from this worktree yet.</div>;

  return <div className={styles.historyGraph} role="list" aria-label="Git commit history">
    {lines.map((line, index) => line.kind === "connector"
      ? <div className={styles.historyConnector} aria-hidden="true" key={`connector-${index}`}><pre>{line.graph}</pre></div>
      : <div className={styles.historyCommit} role="listitem" key={`${line.hash}-${index}`} title={line.hash}>
          <pre className={styles.historyTopology} aria-hidden="true">{line.graph}</pre>
          <code>{line.shortHash}</code>
          <div className={styles.historyIdentity}>
            <span><b>{line.subject}</b>{line.refs.map((ref) => <em className={ref.startsWith("HEAD") ? styles.historyHeadRef : ref.startsWith("tag:") ? styles.historyTagRef : ""} key={ref}>{ref}</em>)}</span>
            <small>{line.author} · {new Date(line.authoredAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}{line.parents.length > 1 ? ` · merge of ${line.parents.length}` : ""}</small>
          </div>
        </div>)}
    {hasMore && <button className={styles.historyMore} disabled={loading} onClick={onLoadMore}>{loading ? "LOADING…" : "LOAD 200 MORE COMMITS"}</button>}
  </div>;
}

function fileParts(filePath: string) {
  const parts = filePath.split("/");
  return { name: parts.pop() || filePath, directory: parts.join("/") };
}

function changeStatusClass(status: string): string {
  const code = status.slice(0, 1).toUpperCase();
  if (code === "D") return styles.status_D;
  if (code === "R") return styles.status_R;
  if (code === "M") return styles.status_M;
  return styles.status_A;
}

function collectTreeFiles(nodes: SprintPilotChangeTreeNode[]): string[] {
  return nodes.flatMap((node) => node.kind === "file" ? [node.path] : collectTreeFiles(node.children));
}

function ChangeTree({
  nodes,
  collapsed,
  activePath,
  action,
  onToggleDirectory,
  onOpenFile,
}: {
  nodes: SprintPilotChangeTreeNode[];
  collapsed: Set<string>;
  activePath?: string;
  action: { kind: "stage" | "unstage"; disabled: boolean; onRun: (paths: string[]) => void };
  onToggleDirectory: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  return <>{nodes.map((node) => {
    if (node.kind === "directory") {
      const isOpen = !collapsed.has(node.path);
      return <div className={styles.treeDirectory} key={node.path}>
        <button className={styles.treeFolderRow} type="button" aria-expanded={isOpen} onClick={() => onToggleDirectory(node.path)} title={node.path}>
          <span className={`${styles.treeChevron} ${isOpen ? styles.treeChevronOpen : ""}`}>›</span>
          <FolderIcon size={15} open={isOpen}/>
          <b>{node.name}</b>
          <small>{node.fileCount}</small>
        </button>
        <button
          type="button"
          className={styles.treeRowAction}
          disabled={action.disabled}
          title={`${action.kind === "stage" ? "Stage" : "Unstage"} everything in ${node.path}`}
          aria-label={`${action.kind === "stage" ? "Stage" : "Unstage"} everything in ${node.path}`}
          onClick={() => action.onRun(collectTreeFiles([node]))}
        >{action.kind === "stage" ? "→" : "←"}</button>
        {isOpen && <div className={styles.treeChildren}><ChangeTree nodes={node.children} collapsed={collapsed} activePath={activePath} action={action} onToggleDirectory={onToggleDirectory} onOpenFile={onOpenFile}/></div>}
      </div>;
    }

    const status = node.status.slice(0, 1).toUpperCase();
    return <div className={`${styles.fileRow} ${styles.treeFileRow} ${activePath === node.path ? styles.activeFile : ""}`} key={node.path}>
      <button type="button" onClick={() => onOpenFile(node.path)} title={node.path}><span className={styles.treeFileIcon}>{getFileIcon(node.name, 15)}</span><span className={styles.fileIdentity}><b>{node.name}</b></span><em className={changeStatusClass(status)}>{status}</em></button>
      <button
        type="button"
        className={styles.treeRowAction}
        disabled={action.disabled}
        title={action.kind === "stage" ? `Stage ${node.path}` : `Unstage ${node.path}`}
        aria-label={action.kind === "stage" ? `Stage ${node.path}` : `Unstage ${node.path}`}
        onClick={() => action.onRun([node.path])}
      >{action.kind === "stage" ? "→" : "←"}</button>
    </div>;
  })}</>;
}

function HighlightedDiffCode({ text, language }: { text: string; language?: string }) {
  if (!language) return <code>{text || " "}</code>;
  return <SyntaxHighlighter
    language={language}
    style={SPRINTPILOT_DIFF_THEME}
    PreTag="code"
    CodeTag="span"
    className={styles.diffSyntax}
    customStyle={{ margin: 0, padding: "0 14px 0 8px", overflow: "visible", background: "transparent", font: "inherit", whiteSpace: "pre" }}
    codeTagProps={{ style: { font: "inherit", whiteSpace: "inherit" } }}
  >{text || " "}</SyntaxHighlighter>;
}

function DiffEditor({
  filePath,
  patch,
  comments,
  onAddComment,
  onDeleteComment,
}: {
  filePath?: string;
  patch: string;
  comments: ReviewComment[];
  onAddComment: (comment: Omit<ReviewComment, "id">) => void;
  onDeleteComment: (id: string) => void;
}) {
  const [commentingOn, setCommentingOn] = useState<{ line: number; side: "old" | "new"; kind: ReviewComment["kind"]; code: string } | null>(null);
  const [commentBody, setCommentBody] = useState("");

  useEffect(() => {
    setCommentingOn(null);
    setCommentBody("");
  }, [filePath]);

  if (!filePath) return <div className={styles.editorEmpty}><span>⌘</span><b>Select a changed file</b><small>Its changes will open here in a read-only editor.</small></div>;
  if (!patch) return <div className={styles.editorEmpty}><span>···</span><b>Loading changes</b></div>;
  const hunks = parseDiff(patch);
  if (!hunks.length) return <div className={styles.editorEmpty}><span>◇</span><b>Preview unavailable</b><small>{patch}</small></div>;
  const { name, directory } = fileParts(filePath);
  const language = sprintPilotDiffLanguage(filePath);
  return <div className={styles.diffEditor}>
    <div className={styles.editorTab}><span className={styles.fileGlyph}>{name.split(".").pop()?.slice(0, 2).toUpperCase() || "F"}</span><b>{name}</b><small>{directory}</small><em>{language ? `${language.toUpperCase()} · ` : ""}READ ONLY</em></div>
    <div className={styles.editorCode}>{hunks.map((hunk, hunkIndex) => <section className={styles.diffHunk} key={`${hunk.label}-${hunkIndex}`}>
      <div className={styles.hunkHeader}><span>⋯</span>{hunk.label}</div>
      {hunk.lines.map((line, lineIndex) => {
        const side = line.kind === "removed" ? "old" : "new";
        const lineNumber = side === "old" ? line.oldLine : line.newLine;
        if (lineNumber === undefined) return null;
        const lineComments = comments.filter((comment) => comment.line === lineNumber && comment.side === side);
        const isCommenting = commentingOn?.line === lineNumber && commentingOn.side === side;
        return <div className={styles.diffLineGroup} key={`${hunkIndex}-${lineIndex}`}>
          <div className={`${styles.codeLine} ${styles[`line_${line.kind}`]}`}>
            <button
              className={`${styles.commentPin} ${lineComments.length ? styles.commentPinActive : ""}`}
              type="button"
              title={`Comment on ${side === "old" ? "old " : ""}line ${lineNumber}`}
              aria-label={`Comment on ${filePath} ${side === "old" ? "old " : ""}line ${lineNumber}`}
              onClick={() => {
                setCommentingOn(isCommenting ? null : { line: lineNumber, side, kind: line.kind, code: line.content });
                setCommentBody("");
              }}
            >{lineComments.length || "+"}</button>
            <span className={styles.oldLine}>{line.oldLine ?? ""}</span><span className={styles.newLine}>{line.newLine ?? ""}</span><span className={styles.changeMark}>{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : ""}</span><HighlightedDiffCode text={line.content} language={language}/>
          </div>
          {lineComments.map((comment) => <div className={`${styles.reviewComment} ${comment.sentAt ? styles.reviewCommentSent : ""}`} key={comment.id}>
            <span>{comment.sentAt ? "SENT TO AGENT" : "REVIEW NOTE"}</span><p>{comment.body}</p><button type="button" onClick={() => onDeleteComment(comment.id)} aria-label={`Delete comment on line ${lineNumber}`}>×</button>
          </div>)}
          {isCommenting && <form className={styles.commentComposer} onSubmit={(event) => {
            event.preventDefault();
            if (!commentBody.trim()) return;
            onAddComment({ filePath, line: lineNumber, side, kind: line.kind, code: line.content, body: commentBody.trim() });
            setCommentingOn(null);
            setCommentBody("");
          }}>
            <label>COMMENT ON {side === "old" ? "OLD " : ""}LINE {lineNumber}</label>
            <textarea autoFocus value={commentBody} onChange={(event) => setCommentBody(event.target.value)} placeholder="Describe what the agent should change…" rows={3}/>
            <div><button type="button" onClick={() => { setCommentingOn(null); setCommentBody(""); }}>CANCEL</button><button type="submit" disabled={!commentBody.trim()}>ADD COMMENT</button></div>
          </form>}
        </div>;
      })}
    </section>)}</div>
  </div>;
}

function isCompletedTask(task: SprintTask) {
  if (task.statusCategory?.toLowerCase() === "done") return true;
  return /^(done|closed|resolved|completed|cancelled|canceled)$/i.test(task.status.trim());
}

function storedCompletedSteps(key: string): WorkflowStep[] {
  try {
    const stored = JSON.parse(localStorage.getItem(COMPLETED_STEPS_KEY) || "{}") as Record<string, string[]>;
    return normalizeCompletedSteps(stored[key] || []);
  } catch {
    return [];
  }
}

function persistCompletedSteps(key: string, completed: string[]) {
  try {
    const stored = JSON.parse(localStorage.getItem(COMPLETED_STEPS_KEY) || "{}") as Record<string, string[]>;
    localStorage.setItem(COMPLETED_STEPS_KEY, JSON.stringify({ ...stored, [key]: normalizeCompletedSteps(completed) }));
  } catch {
    return;
  }
}

function IssueTypeIcon({ type, epic = false }: { type?: string; epic?: boolean }) {
  const normalized = epic ? "epic" : (type || "task").toLowerCase();
  const label = epic ? "Epic" : type || "Task";
  const path = normalized.includes("bug")
    ? <><circle cx="8" cy="8" r="3"/><path d="M8 2v2M8 12v2M2 8h3M11 8h3M3.8 3.8l1.4 1.4M10.8 10.8l1.4 1.4M12.2 3.8l-1.4 1.4M5.2 10.8l-1.4 1.4"/></>
    : normalized.includes("story")
      ? <path d="M3 3h10v10H3zM5.5 6h5M5.5 8.5h5M5.5 11h3"/>
      : normalized.includes("sub")
        ? <path d="M3 3v5h7M7 5l3 3-3 3"/>
        : normalized.includes("epic")
          ? <path d="M2.5 4.5h4l1.5-2 1.5 2h4v7h-4l-1.5 2-1.5-2h-4z"/>
          : <path d="M3 3h10v10H3zM5.5 8l1.7 1.7 3.5-3.5"/>;
  return <span className={`${styles.issueIcon} ${epic ? styles.epicIcon : ""}`} title={label} aria-label={`${label} issue`}><svg viewBox="0 0 16 16" aria-hidden="true">{path}</svg></span>;
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body as T;
}

export function SprintPilot() {
  const [tasks, setTasks] = useState<SprintTask[]>(DEMO_TASKS);
  const [jiraConfigured, setJiraConfigured] = useState(false);
  const [jiraRefreshing, setJiraRefreshing] = useState(false);
  const [lastJiraSync, setLastJiraSync] = useState<Date>();
  const [openKeys, setOpenKeys] = useState<string[]>([DEMO_TASKS[0].key]);
  const [activeKey, setActiveKey] = useState(DEMO_TASKS[0].key);
  const [runtime, setRuntime] = useState<Record<string, TaskRuntime>>({ [DEMO_TASKS[0].key]: initialRuntime() });
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [thinkingLevels, setThinkingLevels] = useState<Record<string, string[]>>({});
  const [authProviders, setAuthProviders] = useState<AuthProvider[]>([]);
  const [providerUsage, setProviderUsage] = useState<SprintPilotUsage | null>(null);
  const [gitFiles, setGitFiles] = useState<GitFile[]>([]);
  const [testFiles, setTestFiles] = useState<string[]>([]);
  const [diff, setDiff] = useState("");
  const [activeDiffFile, setActiveDiffFile] = useState<string>();
  const [historyLines, setHistoryLines] = useState<SprintPilotHistoryLine[]>([]);
  const [historyCommitCount, setHistoryCommitCount] = useState(0);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyCollapsed, setHistoryCollapsed] = useState(false);
  const [collapsedChangeFolders, setCollapsedChangeFolders] = useState<Set<string>>(() => new Set());
  const [developmentOpen, setDevelopmentOpen] = useState(true);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ key: string; worktree: string } | null>(null);
  const [createWorktreeSetup, setCreateWorktreeSetup] = useState<CreateWorktreeSetup | null>(null);
  const [browseRepoOpen, setBrowseRepoOpen] = useState(false);
  const [browseRepoInitialPath, setBrowseRepoInitialPath] = useState<string>();
  const [browseRepoError, setBrowseRepoError] = useState<string>();
  const [linkSetup, setLinkSetup] = useState<LinkSetup | null>(null);
  const [restartStep, setRestartStep] = useState<WorkflowStep | null>(null);
  const [authSetup, setAuthSetup] = useState<AuthSetup | null>(null);
  const [pendingChanges, setPendingChanges] = useState<Record<string, PendingChanges>>({});
  const [ignoredStagePrompt, setIgnoredStagePrompt] = useState<{ files: string[]; message: string } | null>(null);
  const [stagingTab, setStagingTab] = useState<"changes" | "staged">("changes");
  const [commitSetup, setCommitSetup] = useState<CommitSetup | null>(null);
  const [pullRequestSetup, setPullRequestSetup] = useState<PullRequestSetup | null>(null);
  const [agentAlerts, setAgentAlerts] = useState<Record<string, AgentAlert>>({});
  const [agentStates, setAgentStates] = useState<Record<string, AgentStatusSnapshot>>({});
  const authEvents = useRef<EventSource | null>(null);
  const jiraSyncing = useRef(false);
  const agentStatusRef = useRef(new Map<string, { running: boolean; lastFinishedAt?: number }>());

  const task = tasks.find((candidate) => candidate.key === activeKey) || tasks[0];
  const storedState = runtime[activeKey] || initialRuntime();
  const fallbackModel = models.find(isDefaultModel) || models[0];
  const state: TaskRuntime = {
    ...storedState,
    provider: storedState.provider || fallbackModel?.provider,
    modelId: storedState.modelId || fallbackModel?.id,
    effort: storedState.effort || (fallbackModel ? preferredEffort(thinkingLevels, fallbackModel) : "off"),
  };
  const activePreset = TEST_PRESETS.find((preset) => preset.id === state.testPreset) || TEST_PRESETS[0];
  const modelKey = state.provider && state.modelId ? `${state.provider}:${state.modelId}` : "";
  const effortOptions = thinkingLevels[modelKey] || ["off"];

  const updateRuntime = useCallback((patch: Partial<TaskRuntime>) => {
    setRuntime((current) => {
      const next = { ...(current[activeKey] || initialRuntime()), ...patch };
      if (patch.completed) persistCompletedSteps(activeKey, next.completed);
      return { ...current, [activeKey]: next };
    });
  }, [activeKey]);

  const clearAgentAlert = useCallback((key: string) => {
    setAgentAlerts((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  useEffect(() => {
    const receiveSelectedSession = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin || !event.data || typeof event.data !== "object") return;
      const data = event.data as { source?: string; type?: string; sessionId?: string; cwd?: string };
      if (data.source !== "pi-web" || data.type !== "session-selected" || data.cwd !== state.worktree || !data.sessionId) return;
      if (data.sessionId !== state.sessionId) updateRuntime({ sessionId: data.sessionId });
    };
    window.addEventListener("message", receiveSelectedSession);
    return () => window.removeEventListener("message", receiveSelectedSession);
  }, [state.sessionId, state.worktree, updateRuntime]);

  const syncJiraTasks = useCallback(async ({ announce = false, worktrees = [] }: {
    announce?: boolean;
    worktrees?: { key: string; worktree: string; branch?: string }[];
  } = {}) => {
    if (jiraSyncing.current) return;
    jiraSyncing.current = true;
    setJiraRefreshing(true);
    try {
      const jira = await jsonRequest<{ configured: boolean; tasks: SprintTask[] }>("/api/sprintpilot/tasks");
      setJiraConfigured(jira.configured);
      const loadedTasks = jira.configured ? jira.tasks.filter((loadedTask) => !isCompletedTask(loadedTask)) : DEMO_TASKS;
      const validKeys = new Set(loadedTasks.map((loadedTask) => loadedTask.key));
      const worktreesByKey = new Map(worktrees.map((entry) => [entry.key, entry]));
      setTasks(loadedTasks);
      setOpenKeys((current) => {
        const retained = current.filter((key) => validKeys.has(key));
        return retained.length ? retained : loadedTasks[0] ? [loadedTasks[0].key] : [];
      });
      setActiveKey((current) => validKeys.has(current) ? current : loadedTasks[0]?.key || "");
      setRuntime((current) => Object.fromEntries(loadedTasks.map((loadedTask) => {
        const existing = current[loadedTask.key] || initialRuntime();
        return [loadedTask.key, {
          ...existing,
          ...worktreesByKey.get(loadedTask.key),
          completed: normalizeCompletedSteps(
            completedStepsForJiraStatus(loadedTask.status),
            existing.completed.length ? existing.completed : storedCompletedSteps(loadedTask.key),
          ),
        }];
      })));
      setLastJiraSync(new Date());
      if (announce) setNotice(`Jira synchronized. ${loadedTasks.length} active ${loadedTasks.length === 1 ? "ticket" : "tickets"} loaded.`);
    } catch (error) {
      if (announce) setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      jiraSyncing.current = false;
      setJiraRefreshing(false);
    }
  }, []);

  useEffect(() => {
    jsonRequest<{ worktrees: { key: string; worktree: string; branch?: string }[] }>("/api/sprintpilot/worktree")
      .then((worktreeData) => syncJiraTasks({ worktrees: worktreeData.worktrees }))
      .catch((error) => setNotice(error.message));
    jsonRequest<{ providers: AuthProvider[] }>("/api/auth/providers")
      .then((data) => setAuthProviders(data.providers))
      .catch((error) => setNotice(error.message));
    jsonRequest<{ cwd: string }>("/api/default-cwd", { method: "POST" })
      .then(({ cwd }) => jsonRequest<ModelResponse>(`/api/models?cwd=${encodeURIComponent(cwd)}`))
      .then((data) => {
        const relevant = (data.modelList || []).filter((model) => /anthropic|claude|openai|codex/i.test(`${model.provider}/${model.id}`));
        const available = relevant.length ? relevant : (data.modelList || []);
        setModels(available);
        setThinkingLevels(data.thinkingLevels || {});
        const preferred = available.find(isDefaultModel)
          || available.find((model) => model.provider === data.defaultModel?.provider && model.id === data.defaultModel?.modelId)
          || available[0];
        if (preferred) {
          setRuntime((current) => Object.fromEntries(Object.entries(current).map(([key, value]) => [key, {
            ...value,
            provider: value.provider || preferred.provider,
            modelId: value.modelId || preferred.id,
            effort: value.effort || preferredEffort(data.thinkingLevels || {}, preferred),
          }])));
        }
      })
      .catch((error) => setNotice(error.message));
    return () => authEvents.current?.close();
  }, [syncJiraTasks]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void syncJiraTasks();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [syncJiraTasks]);

  useEffect(() => {
    const refreshUsage = () => jsonRequest<{ usage: SprintPilotUsage }>("/api/sprintpilot/usage")
      .then((data) => setProviderUsage(data.usage))
      .catch(() => setProviderUsage(null));
    refreshUsage();
    const timer = window.setInterval(refreshUsage, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const taskAgentSessions = useMemo(() => Object.entries(runtime).flatMap(([key, taskRuntime]) =>
    taskRuntime.sessionId ? [{ key, sessionId: taskRuntime.sessionId }] : []
  ), [runtime]);

  const taskWorktrees = useMemo(() => Object.entries(runtime).flatMap(([key, taskRuntime]) =>
    taskRuntime.worktree ? [{ key, worktree: taskRuntime.worktree }] : []
  ), [runtime]);
  // Serialized so the poll effect re-subscribes when the set of worktrees
  // changes, not on every unrelated runtime update.
  const worktreeKey = taskWorktrees.map(({ worktree }) => worktree).sort().join(",");

  useEffect(() => {
    if (!worktreeKey) {
      setPendingChanges({});
      return;
    }
    let cancelled = false;
    let polling = false;
    const pollPendingChanges = async () => {
      if (polling || document.visibilityState === "hidden") return;
      polling = true;
      try {
        const result = await jsonRequest<{ pending: Record<string, PendingChanges> }>(`/api/sprintpilot/pending-changes?worktrees=${encodeURIComponent(worktreeKey)}`);
        if (cancelled) return;
        const next = Object.fromEntries(taskWorktrees.flatMap(({ key, worktree }) => {
          const pending = result.pending[worktree];
          return pending ? [[key, pending] as const] : [];
        }));
        setPendingChanges((previous) => {
          // A task whose pending work just dropped to zero has been committed,
          // which resolves the agent's turn as surely as replying to it does.
          for (const [key, pending] of Object.entries(next)) {
            if (pending.changed === 0 && (previous[key]?.changed || 0) > 0) clearAgentAlert(key);
          }
          return next;
        });
      } catch {
        // A transient poll failure must not clear a badge the user is reading.
      } finally {
        polling = false;
      }
    };
    pollPendingChanges();
    const timer = window.setInterval(pollPendingChanges, 10_000);
    document.addEventListener("visibilitychange", pollPendingChanges);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", pollPendingChanges);
    };
    // taskWorktrees is re-derived on every runtime change; worktreeKey is the
    // value that actually decides what this effect polls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreeKey]);

  const sortedTasks = useMemo(() => sortSprintTasks(tasks), [tasks]);
  // Tasks whose agent stopped or asked something and has not been answered.
  const awaitingKeys = useMemo(
    () => sortedTasks.filter((item) => agentAlerts[item.key]).map((item) => item.key),
    [sortedTasks, agentAlerts],
  );

  useEffect(() => {
    if (!taskAgentSessions.length) return;
    let cancelled = false;
    let polling = false;
    const pollAgentStates = async () => {
      if (polling) return;
      polling = true;
      try {
        const sessionIds = [...new Set(taskAgentSessions.map(({ sessionId }) => sessionId))];
        const result = await jsonRequest<{ statuses: Record<string, AgentStatusSnapshot> }>(`/api/sprintpilot/agent-status?ids=${encodeURIComponent(sessionIds.join(","))}`);
        const snapshots = taskAgentSessions.map(({ key, sessionId }) => ({ key, sessionId, snapshot: result.statuses[sessionId] }));
        if (cancelled) return;
        setAgentStates((current) => {
          const next = { ...current };
          let changed = false;
          for (const { key, snapshot } of snapshots) {
            if (!snapshot) continue;
            const previous = current[key];
            if (previous?.running === snapshot.running && previous?.queued === snapshot.queued && previous?.needsUserInput === snapshot.needsUserInput && previous?.lastPromptFinishedAt === snapshot.lastPromptFinishedAt) continue;
            next[key] = snapshot;
            changed = true;
          }
          return changed ? next : current;
        });
        setAgentAlerts((current) => {
          const next = { ...current };
          let changed = false;
          for (const result of snapshots) {
            if (!result?.snapshot) continue;
            const { key, sessionId, snapshot } = result;
            const running = snapshot.running;
            const needsInput = snapshot.needsUserInput;
            const lastFinishedAt = snapshot.lastPromptFinishedAt;
            const previous = agentStatusRef.current.get(sessionId);
            const newlyFinished = !running && Boolean(lastFinishedAt) && previous?.lastFinishedAt !== lastFinishedAt;

            if (needsInput) {
              if (next[key] !== "attention") { next[key] = "attention"; changed = true; }
            } else if (running) {
              if (next[key]) { delete next[key]; changed = true; }
            } else if (snapshot.awaitingReply || newlyFinished || previous?.running) {
              // awaitingReply comes from the transcript, so it still reports a
              // waiting agent after a reload, a background tab, or the wrapper's
              // idle timeout — none of which the live-only signals survived.
              if (next[key] !== "finished") { next[key] = "finished"; changed = true; }
            } else if (next[key]) {
              delete next[key];
              changed = true;
            }
            agentStatusRef.current.set(sessionId, { running, lastFinishedAt: lastFinishedAt ?? previous?.lastFinishedAt });
          }
          return changed ? next : current;
        });
      } catch {
        // Preserve the last known signal through a transient monitoring failure.
      } finally {
        polling = false;
      }
    };
    void pollAgentStates();
    const timer = window.setInterval(pollAgentStates, 2_000);
    const handleVisibility = () => { if (document.visibilityState === "visible") void pollAgentStates(); };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [taskAgentSessions]);

  const connectProvider = (provider: "anthropic" | "openai-codex") => {
    authEvents.current?.close();
    setAuthSetup({ provider, phase: "connecting", message: "Preparing a secure Pi authorization session…", input: "" });
    const events = new EventSource(`/api/auth/login/${provider}`);
    authEvents.current = events;
    events.onmessage = (event) => {
      const data = JSON.parse(event.data) as { type: string; url?: string; instructions?: string; token?: string; message?: string; userCode?: string; verificationUri?: string; options?: { id: string; label: string }[] };
      if (data.type === "auth" && data.url && data.token) {
        setAuthSetup({ provider, phase: "auth", url: data.url, token: data.token, message: data.instructions, input: "" });
      } else if (data.type === "device_code" && data.verificationUri) {
        setAuthSetup({ provider, phase: "device", url: data.verificationUri, userCode: data.userCode, message: "Open the verification page and enter this device code. Pi will detect approval automatically." });
      } else if ((data.type === "prompt_request" || data.type === "select_request") && data.token) {
        setAuthSetup((current) => data.type === "prompt_request" && current?.phase === "auth" && current.token === data.token
          ? { ...current, message: data.message || current.message }
          : { provider, phase: data.type === "select_request" ? "select" : "prompt", token: data.token, message: data.message, options: data.options, input: "" });
      } else if (data.type === "progress") setAuthSetup((current) => current ? { ...current, phase: "progress", message: data.message || "Login in progress…" } : current);
      else if (data.type === "success") {
        events.close();
        setAuthSetup({ provider, phase: "success", message: `${providerLabel(provider)} is connected to Pi.` });
      } else if (data.type === "error") {
        events.close();
        setAuthSetup({ provider, phase: "error", message: data.message || "Provider login failed." });
      }
    };
    events.onerror = () => {
      events.close();
      setAuthSetup((current) => current?.phase === "success" ? current : current ? { ...current, phase: "error", message: "The Pi authorization connection closed before login completed." } : current);
    };
  };

  const submitAuth = async (value: string) => {
    if (!authSetup?.token || !value.trim()) return;
    try {
      await jsonRequest(`/api/auth/login/${authSetup.provider}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: authSetup.token, code: value.trim() }),
      });
      setAuthSetup((current) => current ? { ...current, phase: "progress", message: "Authorization submitted. Waiting for Pi to verify it…" } : current);
    } catch (error) {
      setAuthSetup((current) => current ? { ...current, phase: "error", message: error instanceof Error ? error.message : String(error) } : current);
    }
  };

  const closeAuth = () => {
    authEvents.current?.close();
    authEvents.current = null;
    setAuthSetup(null);
  };

  const refreshWorkspace = useCallback(async () => {
    if (!state.worktree) {
      setGitFiles([]);
      setTestFiles([]);
      return;
    }
    const [git, tests] = await Promise.all([
      jsonRequest<{ files: GitFile[] }>(`/api/git/status?cwd=${encodeURIComponent(state.worktree)}`),
      jsonRequest<{ files: string[] }>(`/api/sprintpilot/tests?cwd=${encodeURIComponent(state.worktree)}`),
    ]);
    setGitFiles(git.files);
    setTestFiles(tests.files);
  }, [state.worktree]);

  const refreshHistory = useCallback(async (skip = 0, append = false) => {
    if (!state.worktree) {
      setHistoryLines([]);
      setHistoryCommitCount(0);
      setHistoryHasMore(false);
      return;
    }
    setHistoryLoading(true);
    try {
      const result = await jsonRequest<{ lines: SprintPilotHistoryLine[]; totalCommitCount: number; hasMore: boolean }>(`/api/sprintpilot/git/history?cwd=${encodeURIComponent(state.worktree)}&skip=${skip}&limit=${HISTORY_PAGE_SIZE}`);
      setHistoryLines((current) => append ? [...current, ...result.lines] : result.lines);
      setHistoryCommitCount(result.totalCommitCount);
      setHistoryHasMore(result.hasMore);
    } finally {
      setHistoryLoading(false);
    }
  }, [state.worktree]);

  useEffect(() => {
    refreshWorkspace().catch((error) => setNotice(error.message));
  }, [refreshWorkspace, activeKey]);

  useEffect(() => {
    refreshHistory().catch((error) => setNotice(error.message));
  }, [refreshHistory, activeKey]);

  useEffect(() => {
    setActiveDiffFile(undefined);
    setDiff("");
    setCollapsedChangeFolders(new Set());
  }, [activeKey]);

  const openTask = (key: string) => {
    setOpenKeys((keys) => keys.includes(key) ? keys : [...keys, key]);
    setRuntime((current) => {
      if (current[key]) return current;
      const selectedTask = tasks.find((candidate) => candidate.key === key);
      return { ...current, [key]: {
        ...initialRuntime(),
        completed: normalizeCompletedSteps(selectedTask ? completedStepsForJiraStatus(selectedTask.status) : [], storedCompletedSteps(key)),
      } };
    });
    // Deliberately not cleared here. Opening the tab is how the operator reads
    // what the agent said; dismissing the signal at that moment meant a task
    // waiting on a reply looked identical to one with nothing pending. The
    // alert is released when the operator actually answers, in queueTaskPrompt.
    setActiveKey(key);
  };

  const handleFlowStep = (step: WorkflowStep) => {
    if (state.completed.includes(step)) {
      setRestartStep(step);
      return;
    }
    const completed = normalizeCompletedSteps(state.completed, [step]);
    updateRuntime({ completed });
    setNotice(`${step} marked complete for ${task?.key}. Click it again to send that workflow step to the task agent.`);
  };

  const restartCompletedStep = async () => {
    if (!restartStep) return;
    const step = restartStep;
    setRestartStep(null);
    await sendWorkflowPrompt(step);
  };

  const createTaskSession = async () => {
    if (!state.worktree || !state.provider || !state.modelId) throw new Error("Choose a worktree and model before opening the task chat");
    const result = await jsonRequest<{ sessionId: string }>("/api/agent/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: state.worktree, type: "ensure_session", provider: state.provider, modelId: state.modelId, thinkingLevel: state.effort }),
    });
    updateRuntime({ sessionId: result.sessionId });
    setDevelopmentOpen(true);
    return result.sessionId;
  };

  const ensureTaskSession = async (fresh = false) => fresh || !state.sessionId
    ? createTaskSession()
    : state.sessionId;

  const queueTaskPrompt = async (message: string, fresh = false) => {
    let sessionId = await ensureTaskSession(fresh);
    // Answering the agent is what resolves the alert, whichever surface the
    // prompt came from.
    clearAgentAlert(activeKey);
    try {
      await sendAgentCommand(sessionId, { type: "prompt", message, streamingBehavior: "followUp" });
    } catch (error) {
      // A manually deleted/expired session should not strand this Jira task.
      if (!(error instanceof AgentCommandError) || error.status !== 404 || fresh) throw error;
      sessionId = await createTaskSession();
      await sendAgentCommand(sessionId, { type: "prompt", message, streamingBehavior: "followUp" });
    }
    return sessionId;
  };

  const sendWorkflowPrompt = async (step: WorkflowStep) => {
    const prompt = task ? sprintPilotWorkflowPrompt(step, task) : undefined;
    if (!task || !state.worktree || !state.provider || !state.modelId || !prompt) return;
    clearAgentAlert(task.key);
    setBusy(step);
    try {
      const sessionId = await queueTaskPrompt(prompt);
      updateRuntime({ sessionId, completed: normalizeCompletedSteps(state.completed, [step]) });
      setNotice(`${step} sent to the task agent. It will run next if the agent is already busy.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const openTaskConversation = async (fresh = false) => {
    if (!task || !state.worktree || !state.provider || !state.modelId) return;
    clearAgentAlert(task.key);
    setBusy(fresh ? "fresh-development-session" : "development-session");
    try {
      const sessionId = await ensureTaskSession(fresh);
      updateRuntime({ sessionId });
      setDevelopmentOpen(true);
      setNotice(fresh ? `New task chat opened for ${task.key}.` : `Task chat ready for ${task.key}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const startDevelopmentSession = () => openTaskConversation();

  const startFreshDevelopmentSession = () => openTaskConversation(true);

  const openCreateWorktree = async () => {
    setCreateWorktreeSetup({ loading: true, sources: [] });
    try {
      const result = await jsonRequest<{ sources: WorktreeSource[] }>("/api/sprintpilot/worktree?sources=1");
      setCreateWorktreeSetup({ loading: false, sources: result.sources });
    } catch (error) {
      setCreateWorktreeSetup({ loading: false, sources: [], error: error instanceof Error ? error.message : String(error) });
    }
  };

  const createWorktree = async ({ source, repoRoot }: { source?: string; repoRoot?: string }) => {
    if (!task) return;
    setBusy("worktree");
    setBrowseRepoError(undefined);
    try {
      const result = await jsonRequest<{ worktree: string; branch: string; source: string; reusedBranch?: boolean }>("/api/sprintpilot/worktree", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...task, source, repoRoot }),
      });
      updateRuntime(result);
      setCreateWorktreeSetup(null);
      setBrowseRepoOpen(false);
      setNotice(result.reusedBranch
        ? `${result.source} worktree recreated on retained branch: ${result.branch}`
        : `Fresh ${result.source} worktree created from origin/main: ${result.branch}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (repoRoot) setBrowseRepoError(message);
      else setCreateWorktreeSetup((current) => current ? { ...current, error: message } : current);
      setNotice(message);
    }
    finally { setBusy(null); }
  };

  const findExistingWorktrees = async () => {
    if (!task) return;
    const key = task.key;
    setLinkSetup({ key, loading: true, candidates: [] });
    try {
      const result = await jsonRequest<{ candidates: WorktreeCandidate[] }>(`/api/sprintpilot/worktree?key=${encodeURIComponent(key)}`);
      setLinkSetup({ key, loading: false, candidates: result.candidates, selected: result.candidates[0]?.worktree });
    } catch (error) {
      setLinkSetup({ key, loading: false, candidates: [], error: error instanceof Error ? error.message : String(error) });
    }
  };

  const linkExistingWorktree = async () => {
    if (!linkSetup?.selected || linkSetup.key !== activeKey) return;
    setBusy("link-worktree");
    try {
      const result = await jsonRequest<{ worktree: string; branch?: string }>("/api/sprintpilot/worktree", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: linkSetup.key, cwd: linkSetup.selected }),
      });
      updateRuntime(result);
      setLinkSetup(null);
      setNotice(`Linked existing worktree: ${result.worktree}`);
    } catch (error) {
      setLinkSetup((current) => current ? { ...current, error: error instanceof Error ? error.message : String(error) } : current);
    } finally {
      setBusy(null);
    }
  };

  const deleteWorktree = async () => {
    if (!deleteTarget) return;
    setBusy("delete-worktree");
    try {
      await jsonRequest("/api/sprintpilot/worktree", {
        method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: deleteTarget.worktree }),
      });
      updateRuntime({ worktree: undefined, branch: undefined, sessionId: undefined, approvalToken: undefined, completed: task ? completedStepsForJiraStatus(task.status) : [] });
      setDeleteTarget(null);
      setNotice(`Deleted the ${deleteTarget.key} worktree. Its Git branch was retained.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const inspectDiff = async (file: GitFile) => {
    if (!state.worktree) return;
    setActiveDiffFile(file.filePath);
    setDiff("");
    try {
      const result = await jsonRequest<{ supported: boolean; patch?: string }>(`/api/git/diff?cwd=${encodeURIComponent(state.worktree)}&path=${encodeURIComponent(file.filePath)}`);
      setDiff(result.supported && result.patch ? result.patch : "This file is binary or too large to preview. Open the full Pi workspace to inspect it.");
    } catch (error) {
      setDiff(error instanceof Error ? error.message : String(error));
    }
  };

  const addReviewComment = (comment: Omit<ReviewComment, "id">) => {
    updateRuntime({ reviewComments: [...state.reviewComments, { ...comment, id: crypto.randomUUID() }] });
  };

  const deleteReviewComment = (id: string) => {
    updateRuntime({ reviewComments: state.reviewComments.filter((comment) => comment.id !== id) });
  };

  const sendReviewComments = async () => {
    if (!task || !state.worktree || !state.provider || !state.modelId) return;
    const pending = state.reviewComments.filter((comment) => !comment.sentAt);
    const message = buildReviewFixPrompt(task.key, pending);
    if (!message) return;

    setBusy("review-comments");
    try {
      const sessionId = await queueTaskPrompt(message);

      const sentIds = new Set(pending.map((comment) => comment.id));
      const sentAt = new Date().toISOString();
      updateRuntime({
        sessionId,
        reviewComments: state.reviewComments.map((comment) => sentIds.has(comment.id) ? { ...comment, sentAt } : comment),
      });
      setDevelopmentOpen(true);
      setNotice(`${pending.length} review ${pending.length === 1 ? "comment" : "comments"} sent to the active Pi session with file and line references.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const runTest = async () => {
    if (!state.worktree || !state.testFile) return;
    setBusy("test"); setNotice("Test running… output will appear here when it finishes.");
    try {
      const result = await jsonRequest<{ output: string }>("/api/sprintpilot/tests", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: state.worktree, file: state.testFile, preset: state.testPreset, options: state.testOptions }),
      });
      updateRuntime({ completed: normalizeCompletedSteps(state.completed, ["Test"]) });
      setNotice(result.output || "Test completed successfully.");
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(null); }
  };

  const openChangedFile = useCallback((path: string) => {
    const file = gitFiles.find((candidate) => (state.worktree ? candidate.filePath.replace(`${state.worktree}/`, "") : candidate.filePath) === path);
    if (file) void inspectDiff(file);
    // inspectDiff is stable for the active worktree; gitFiles is the live list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gitFiles, state.worktree]);

  const toggleChangeFolder = useCallback((path: string) => setCollapsedChangeFolders((current) => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  }), []);

  /**
   * Stage or unstage through Git itself. The index is the commit, so the panel
   * never keeps its own parallel idea of what is included; it re-reads the
   * worktree afterwards and renders whatever Git now reports.
   */
  const runStaging = async (action: "stage" | "unstage", files: string[], force = false) => {
    if (!state.worktree || !files.length) return;
    setBusy(action);
    try {
      const response = await fetch("/api/sprintpilot/git", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, cwd: state.worktree, files, force }),
      });
      const result = await response.json() as { error?: string; ignored?: boolean };
      if (response.status === 409 && result.ignored) {
        setIgnoredStagePrompt({ files, message: result.error || "Those paths are ignored by a .gitignore rule." });
        return;
      }
      if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
      // Drafting is bound to the exact staged set, so changing it invalidates
      // any message already approved for the previous one.
      updateRuntime({ approvalToken: undefined });
      await refreshWorkspace();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const gitAction = async (action: "approve" | "commit" | "push" | "pr", extra: Record<string, unknown> = {}) => {
    if (!state.worktree || !task) return;
    setBusy(action);
    try {
      const result = await jsonRequest<{ approvalToken?: string; output?: string; url?: string; jiraDevelopment?: { state: "linked" | "pending" | "unavailable"; error?: string } }>("/api/sprintpilot/git", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, cwd: state.worktree, approvalToken: state.approvalToken, title: `${task.key}: ${task.summary}`, ...extra }),
      });
      if (action === "commit") {
        setCommitSetup(null);
        setActiveDiffFile(undefined);
        setDiff("");
        updateRuntime({ approvalToken: undefined, completed: normalizeCompletedSteps(state.completed, ["Commit"]) });
        const refreshes = await Promise.allSettled([refreshWorkspace(), refreshHistory(0)]);
        const refreshFailure = refreshes.find((refresh) => refresh.status === "rejected");
        if (refreshFailure?.status === "rejected") {
          setNotice(`Commit complete, but the workspace refresh failed: ${refreshFailure.reason instanceof Error ? refreshFailure.reason.message : String(refreshFailure.reason)}`);
          return;
        }
      }
      if (action === "push") updateRuntime({ completed: normalizeCompletedSteps(state.completed, ["Push"]) });
      if (action === "pr") {
        updateRuntime({ completed: normalizeCompletedSteps(state.completed, ["Open PR"]) });
        const jiraState = result.jiraDevelopment;
        if (jiraState?.state === "linked") setNotice(`${result.url || "Pull request created"} · Jira Development link confirmed.`);
        else if (jiraState?.state === "pending") setNotice(`${result.url || "Pull request created"} · GitHub for Atlassian has not ingested the PR yet. If it remains missing, run the official GitHub backfill in Jira.`);
        else setNotice(`${result.url || "Pull request created"} · Jira Development verification unavailable${jiraState?.error ? `: ${jiraState.error}` : "."}`);
        return true;
      }
      setNotice(result.url || result.output || (action === "approve" ? "Selection approved. The token expires in 30 minutes and becomes invalid if any selected file changes." : `${action} complete.`));
      return true;
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); return false; }
    finally { setBusy(null); }
  };

  const prepareCommit = async () => {
    if (!state.worktree || !task) return;
    setCommitSetup({ phase: "loading", message: "" });
    setBusy("commit-message");
    try {
      const sessionId = await ensureTaskSession();
      const result = await jsonRequest<{ message: string; approvalToken: string } & DraftOrigin>("/api/sprintpilot/git", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "commit-message", cwd: state.worktree, sessionId, taskKey: task.key, summary: task.summary, taskDescription: task.description, title: `${task.key}: ${task.summary}` }),
      });
      updateRuntime({ sessionId, approvalToken: result.approvalToken });
      setCommitSetup({ phase: "ready", message: result.message, generatedBy: result.generatedBy, model: result.model, fallbackReason: result.fallbackReason });
    } catch (error) {
      setCommitSetup({ phase: "error", message: "", error: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  const preparePullRequest = async (draft: boolean) => {
    if (!task || !state.worktree || !state.provider || !state.modelId) return;
    setPullRequestSetup({ phase: "loading", draft, title: "", description: "" });
    setBusy("pr-metadata");
    try {
      const sessionId = await ensureTaskSession();
      const metadata = await jsonRequest<{ title: string; description: string } & DraftOrigin>("/api/sprintpilot/pr-metadata", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: state.worktree, sessionId, taskKey: task.key, summary: task.summary, taskDescription: task.description }),
      });
      updateRuntime({ sessionId });
      setPullRequestSetup({ phase: "ready", draft, title: metadata.title, description: metadata.description, generatedBy: metadata.generatedBy, model: metadata.model });
    } catch (error) {
      setPullRequestSetup({ phase: "error", draft, title: "", description: "", error: error instanceof Error ? error.message : String(error) });
    } finally { setBusy(null); }
  };

  const providerGroups = useMemo(() => [...new Set(models.map((model) => model.provider))], [models]);
  const claudeConnected = authProviders.find((provider) => provider.id === "anthropic")?.loggedIn;
  const codexConnected = authProviders.find((provider) => provider.id === "openai-codex")?.loggedIn;
  const relativeGitFiles = useMemo(() => gitFiles.map((file) => ({
    source: file,
    relativePath: state.worktree ? file.filePath.replace(`${state.worktree}/`, "") : file.filePath,
  })), [gitFiles, state.worktree]);
  const stagedFiles = useMemo(
    () => relativeGitFiles.filter((file) => file.source.indexStatus && !" ?".includes(file.source.indexStatus)).map((file) => file.relativePath).sort(),
    [relativeGitFiles],
  );
  // A path can be in both columns: "MM" is a staged change with further edits
  // on top. Git reports it that way and the panel shows it that way.
  const unstagedFiles = useMemo(
    () => relativeGitFiles.filter((file) => file.source.worktreeStatus && file.source.worktreeStatus !== " ").map((file) => file.relativePath).sort(),
    [relativeGitFiles],
  );
  const stagedTree = useMemo(
    () => buildSprintPilotChangeTree(relativeGitFiles.filter((file) => stagedFiles.includes(file.relativePath)).map((file) => ({ filePath: file.relativePath, status: file.source.status }))),
    [relativeGitFiles, stagedFiles],
  );
  const unstagedTree = useMemo(
    () => buildSprintPilotChangeTree(relativeGitFiles.filter((file) => unstagedFiles.includes(file.relativePath)).map((file) => ({ filePath: file.relativePath, status: file.source.status }))),
    [relativeGitFiles, unstagedFiles],
  );
  const activeDiffPath = activeDiffFile
    ? (state.worktree ? activeDiffFile.replace(`${state.worktree}/`, "") : activeDiffFile)
    : undefined;
  const pendingReviewComments = state.reviewComments.filter((comment) => !comment.sentAt);

  return <main className={styles.shell}>
    <header className={styles.topbar}>
      <div className={styles.brand}><span className={styles.mark}>π</span><div><strong>SPRINTPILOT</strong><small>CONTROL PLANE</small></div></div>
      <div className={styles.headerRight}>
        <div className={`${styles.usageRail} ${styles.headerUsage}`} aria-label="Provider rate-limit usage"><span className={styles.usageWindow}>AI LIMITS</span><RateLimitBadge label="CLAUDE" limits={providerUsage?.claude.rateLimits}/><RateLimitBadge label="CODEX" limits={providerUsage?.codex.rateLimits} showFiveHour={false}/></div>
        <details className={styles.providerMenu}>
          <summary>PROVIDERS <span aria-hidden="true">⌄</span></summary>
          <div className={styles.providerPopover}>
            <div className={styles.providerStatus}><span><i className={jiraConfigured ? styles.statusOnline : styles.statusOffline}/>JIRA</span><b>{jiraConfigured ? "LIVE" : "DEMO"}</b></div>
            <div className={styles.providerStatus}><span><i className={claudeConnected ? styles.statusOnline : styles.statusOffline}/>CLAUDE</span><b>{claudeConnected ? "CONNECTED" : "OFFLINE"}</b></div>
            <div className={styles.providerStatus}><span><i className={codexConnected ? styles.statusOnline : styles.statusOffline}/>CODEX</span><b>{codexConnected ? "CONNECTED" : "OFFLINE"}</b></div>
            <a className={styles.providerConsoleLink} href="/chat">MODEL AUTH &amp; PI CONSOLE ↗</a>
          </div>
        </details>
      </div>
    </header>

    <div className={styles.layout}>
      <aside className={styles.sidebar}>
        <div className={styles.sectionLabel}>CURRENT SPRINT <span>{tasks.length}</span></div>
        {awaitingKeys.length > 0 && <button
          type="button"
          className={styles.awaitingBanner}
          title="Jump to the task whose agent is waiting for a reply"
          onClick={() => openTask(awaitingKeys[0])}
        ><i/><b>{awaitingKeys.length} AGENT{awaitingKeys.length === 1 ? "" : "S"} AWAITING YOU</b><span>{awaitingKeys.join(" · ")}</span></button>}
        <div className={styles.jiraSyncBar}><button disabled={jiraRefreshing} onClick={() => syncJiraTasks({ announce: true })}><span aria-hidden="true">↻</span>{jiraRefreshing ? "SYNCING JIRA…" : "REFRESH JIRA"}</button><small title={lastJiraSync ? `Last synced ${lastJiraSync.toLocaleString()}` : "Waiting for first sync"}>AUTO · 1 MIN{lastJiraSync ? ` · ${lastJiraSync.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}</small></div>
        {!jiraConfigured && <p className={styles.jiraWarning}><b>DEMO DATA</b> Jira is not connected. Copy <code>sprintpilot.env.example</code> to <code>.env.local</code>, add your Jira email and API token, then restart the app.</p>}
        <div className={styles.taskList}>{SPRINT_TASK_GROUPS.flatMap((group) => {
          const groupTasks = sortedTasks.filter((item) => sprintTaskGroup(item) === group.id);
          if (!groupTasks.length) return [];
          const groupPending = groupTasks.reduce((total, item) => total + (pendingChanges[item.key]?.changed || 0), 0);
          return [
            <div key={`group-${group.id}`} className={styles.taskGroupLabel}>
              <span>{group.label}</span>
              <b>{groupTasks.length}</b>
              {groupPending > 0 && <em title={`${groupPending} uncommitted ${groupPending === 1 ? "file" : "files"} in this group`}>{groupPending} PENDING</em>}
            </div>,
            ...groupTasks.map((item) => {
              const agentAlert = agentAlerts[item.key];
              const status = agentRailStatus(agentStates[item.key], agentAlert);
              const pending = pendingChanges[item.key];
              return <button key={item.key} className={`${styles.taskCard} ${item.key === activeKey ? styles.activeTask : ""} ${pending?.changed ? styles.taskCardPending : ""} ${agentAlert === "attention" ? styles.taskCardAgentAttention : agentAlert === "finished" ? styles.taskCardAgentFinished : ""}`} onClick={() => openTask(item.key)}>
                <span className={styles.taskMeta}><span className={styles.keyIdentity}><IssueTypeIcon type={item.issueType}/><b>{item.key}</b><small>{item.issueType || "Task"}</small></span><i>{item.priority}</i></span>
                {item.epicName && <span className={styles.taskEpic}><IssueTypeIcon epic/><b>EPIC</b><strong>{item.epicKey}</strong><span>{item.epicName}</span></span>}
                <span className={styles.taskTitle}>{item.summary}</span>
                <span className={styles.taskStatus}>{item.status}</span>
                {pending?.changed ? <span className={styles.taskPendingSignal} title={`${pending.changed} uncommitted ${pending.changed === 1 ? "file" : "files"}${pending.staged ? `, ${pending.staged} already staged` : ""} — review and commit`}><i/>{pending.changed} TO REVIEW{pending.staged ? ` · ${pending.staged} STAGED` : ""}</span> : null}
                {status && <span className={`${styles.taskAgentSignal} ${styles[`taskAgent_${status}`]}`} title={AGENT_RAIL_STATUS[status].title}><i/>{AGENT_RAIL_STATUS[status].label}</span>}
              </button>;
            }),
          ];
        })}</div>
      </aside>

      <section className={styles.workspace}>
        <nav className={styles.tabs}>{openKeys.map((key) => <button key={key} onClick={() => setActiveKey(key)} className={key === activeKey ? styles.activeTab : ""}>{key}<span>×</span></button>)}</nav>
        {task && <>
          <div className={styles.taskHeader}>
            <div><span className={styles.eyebrow}><span><IssueTypeIcon type={task.issueType}/>{task.issueType || "Task"} {task.key}</span><span>{task.status}</span>{task.epicName && <span><IssueTypeIcon epic/>EPIC {task.epicKey} · {task.epicName}</span>}</span><h1>{task.summary}</h1><p>{state.worktree || "No worktree yet — create one from the latest origin/main before starting."}</p></div>
            {!state.worktree
              ? <div className={styles.worktreeActions}><button className={styles.primary} disabled={!!busy} onClick={openCreateWorktree}>{busy === "worktree" ? "CREATING…" : "CREATE WORKTREE"}</button><button className={styles.secondary} disabled={!!busy} onClick={findExistingWorktrees}>LINK EXISTING WT</button></div>
              : <button className={styles.danger} disabled={!!busy} onClick={() => setDeleteTarget({ key: task.key, worktree: state.worktree! })}>DELETE WT</button>}
          </div>

          <section className={styles.modelBar} aria-label="Model selection">
            <div><label>ENGINE</label><span className={styles.enginePair}><b>Claude Code</b><em>+</em><b>Codex</b></span></div>
            <label>PROVIDER<select value={state.provider || ""} onChange={(event) => {
              const first = models.find((model) => model.provider === event.target.value);
              updateRuntime({ provider: event.target.value, modelId: first?.id, effort: first ? (thinkingLevels[`${first.provider}:${first.id}`] || ["off"])[0] : "off" });
            }}>{providerGroups.map((provider) => <option key={provider} value={provider}>{providerLabel(provider)} · {provider}</option>)}</select></label>
            <label>MODEL<select value={state.modelId || ""} onChange={(event) => {
              const selected = models.find((model) => model.id === event.target.value && model.provider === state.provider);
              if (selected) updateRuntime({ modelId: selected.id, effort: (thinkingLevels[`${selected.provider}:${selected.id}`] || ["off"])[0] });
            }}>{models.filter((model) => model.provider === state.provider).map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>
            <label>EFFORT<select value={state.effort || effortOptions[0]} onChange={(event) => updateRuntime({ effort: event.target.value })}>{effortOptions.map((effort) => <option key={effort}>{effort}</option>)}</select></label>
            {state.sessionId && <a className={styles.sessionLink} href={`/chat?session=${encodeURIComponent(state.sessionId)}`}>OPEN ACTIVE PI SESSION ↗</a>}
          </section>
          {(!claudeConnected || !codexConnected) && <section className={styles.connectBar}>
            <span>PI needs one-time provider authorization before those models can run.</span>
            {!claudeConnected && <button onClick={() => connectProvider("anthropic")}>CONNECT CLAUDE CODE</button>}
            {!codexConnected && <button onClick={() => connectProvider("openai-codex")}>CONNECT CODEX</button>}
          </section>}

          <div className={styles.flow}>{WORKFLOW_STEPS.map((step, index) => {
            const completed = state.completed.includes(step);
            const jiraSynced = task ? completedStepsForJiraStatus(task.status).includes(step) : false;
            return <button type="button" key={step} className={completed ? styles.flowDone : ""} aria-pressed={completed} disabled={!!busy} title={completed ? `${step} is complete${jiraSynced ? ` from Jira status ${task.status}` : ""}. Click to queue it in the task chat.` : `Mark ${step} complete.`} onClick={() => handleFlowStep(step)}><span>{completed ? "✓" : String(index + 1).padStart(2, "0")}</span><b>{step}</b></button>;
          })}</div>
          <p className={styles.flowHint}>Click an incomplete step to mark it done. Click a completed step to queue that workflow step in the task conversation. Jira “In CR” completes Plan and Develop.</p>

          <div className={styles.grid}>
            <section className={`${styles.panel} ${styles.developmentPanel}`}>
              <div className={styles.panelHead}><span>TASK CONVERSATION</span><small>{state.sessionId ? `${providerLabel(state.provider || "")} · ${state.modelId}` : "ONE PI SESSION PER TASK"}</small></div>
              {!state.worktree ? <div className={styles.developmentEmpty}><p>Link or create a worktree to start a development conversation for this Jira task.</p></div>
                : !state.sessionId ? <div className={styles.developmentEmpty}><p>Open one task conversation. Workflow shortcuts, review comments, and your own messages all use it, so context stays in one place.</p><button className={styles.primary} disabled={!!busy || !state.provider || !state.modelId} onClick={startDevelopmentSession}>{busy === "development-session" ? "OPENING…" : "OPEN TASK CHAT"}</button></div>
                  : <><div className={styles.developmentToolbar}><span>● TASK CHAT · {agentAlerts[task.key] === "attention" ? "INPUT NEEDED" : agentAlerts[task.key] === "finished" ? "READY FOR NEXT STEP" : "CHATS SCOPED TO THIS WORKTREE"}</span><button onClick={() => setDevelopmentOpen((open) => !open)}>{developmentOpen ? "COLLAPSE" : "EXPAND"}</button><button disabled={!!busy} onClick={startFreshDevelopmentSession}>{busy === "fresh-development-session" ? "OPENING…" : "NEW CLEAN CHAT"}</button><a href={`/chat?session=${encodeURIComponent(state.sessionId)}`}>OPEN FULL PI CHAT ↗</a></div><div className={styles.agentShortcutBar}><span>QUEUE IN TASK CHAT</span>{AGENT_STEPS.map((step) => <button key={step} disabled={!!busy} onClick={() => sendWorkflowPrompt(step)}>{busy === step ? "QUEUING…" : step}</button>)}<small>Running work is queued after the current task completes.</small></div>{developmentOpen && <iframe className={styles.developmentFrame} title={`${task.key} worktree conversations`} src={`/chat?session=${encodeURIComponent(state.sessionId)}&embedded=1&palette=sprintpilot&scopeCwd=${encodeURIComponent(state.worktree)}`}/>}</>}
            </section>

            <section className={`${styles.panel} ${styles.changesPanel}`}>
              <div className={styles.panelHead}><span>REVIEW FILES &amp; COMMIT</span><small className={state.approvalToken ? styles.approvedState : styles.pendingState}>{state.approvalToken ? `✓ ${stagedFiles.length} STAGED · MESSAGE READY` : `${stagedFiles.length} STAGED · ${unstagedFiles.length} UNSTAGED`}</small></div>
              <div className={styles.reviewTools}><button disabled={!state.worktree || !!busy} onClick={() => refreshWorkspace().then(() => setNotice("Pending changes refreshed.")).catch((error) => setNotice(error.message))}>REFRESH CHANGES</button><span>Stage what belongs in this commit, then draft the message.</span></div>
              <div className={styles.changeLayout}>
                <div className={styles.fileExplorer}>
                  <div className={styles.stagingTabs} role="tablist" aria-label="Changed and staged files">
                    <button type="button" role="tab" aria-selected={stagingTab === "changes"} className={stagingTab === "changes" ? styles.activeStagingTab : ""} onClick={() => setStagingTab("changes")}>CHANGES <b>{unstagedFiles.length}</b></button>
                    <button type="button" role="tab" aria-selected={stagingTab === "staged"} className={stagingTab === "staged" ? styles.activeStagingTab : ""} onClick={() => setStagingTab("staged")}>STAGED <b>{stagedFiles.length}</b></button>
                    {stagingTab === "changes"
                      ? unstagedFiles.length > 0 && <button type="button" className={styles.columnAction} disabled={!!busy} title="Stage every change" aria-label="Stage every change" onClick={() => runStaging("stage", unstagedFiles)}>STAGE ALL →</button>
                      : stagedFiles.length > 0 && <button type="button" className={styles.columnAction} disabled={!!busy} title="Unstage everything" aria-label="Unstage everything" onClick={() => runStaging("unstage", stagedFiles)}>← UNSTAGE ALL</button>}
                  </div>
                  <div className={styles.fileList}>{stagingTab === "changes"
                    ? (unstagedFiles.length ? <ChangeTree
                      nodes={unstagedTree}
                      collapsed={collapsedChangeFolders}
                      activePath={activeDiffPath}
                      action={{ kind: "stage", disabled: !!busy, onRun: (paths) => runStaging("stage", paths) }}
                      onToggleDirectory={toggleChangeFolder}
                      onOpenFile={openChangedFile}
                    /> : <p className={styles.empty}>{state.worktree ? "Nothing unstaged." : "Link or create a worktree to review its files."}</p>)
                    : (stagedFiles.length ? <ChangeTree
                      nodes={stagedTree}
                      collapsed={collapsedChangeFolders}
                      activePath={activeDiffPath}
                      action={{ kind: "unstage", disabled: !!busy, onRun: (paths) => runStaging("unstage", paths) }}
                      onToggleDirectory={toggleChangeFolder}
                      onOpenFile={openChangedFile}
                    /> : <p className={styles.empty}>Nothing staged yet. Stage from Changes with →.</p>)}</div>
                </div>
                <DiffEditor
                  filePath={activeDiffFile ? (state.worktree ? activeDiffFile.replace(`${state.worktree}/`, "") : activeDiffFile) : undefined}
                  patch={diff}
                  comments={state.reviewComments.filter((comment) => comment.filePath === (activeDiffFile ? (state.worktree ? activeDiffFile.replace(`${state.worktree}/`, "") : activeDiffFile) : ""))}
                  onAddComment={addReviewComment}
                  onDeleteComment={deleteReviewComment}
                />
              </div>
              <div className={styles.reviewDispatch}>
                <div><b>{pendingReviewComments.length ? `${pendingReviewComments.length} REVIEW ${pendingReviewComments.length === 1 ? "COMMENT" : "COMMENTS"} READY` : "NO UNSENT REVIEW COMMENTS"}</b><span>Use the + control beside a changed line to attach a precise fix reference.</span></div>
                <button className={styles.sendReviewButton} disabled={!pendingReviewComments.length || !state.worktree || !state.provider || !state.modelId || !!busy} onClick={sendReviewComments}>{busy === "review-comments" ? "SENDING TO AGENT…" : `SEND ${pendingReviewComments.length || ""} TO AGENT`}</button>
              </div>
              <div className={styles.approvalNote}>{state.approvalToken ? <span className={styles.approvedState}>✓ The reviewed message is bound to exactly what is staged now. Staging or unstaging anything asks you to draft it again.</span> : <span>Stage what belongs in this commit with →, then draft the message. The commit records the staged files, nothing else.</span>}</div>
              <div className={styles.gitGates}>
                <button disabled={!stagedFiles.length || !!busy} onClick={prepareCommit}>1 · REVIEW COMMIT MESSAGE</button>
                <button disabled={!state.worktree || !!busy} onClick={() => gitAction("push")}>2 · PUSH BRANCH</button>
                <div className={styles.prSplit}><button disabled={!state.worktree || !state.provider || !state.modelId || !!busy} onClick={() => preparePullRequest(true)}>3A · DRAFT PR DETAILS</button><button disabled={!state.worktree || !state.provider || !state.modelId || !!busy} onClick={() => preparePullRequest(false)}>3B · READY PR DETAILS</button></div>
              </div>
            </section>

            <section className={`${styles.panel} ${styles.historyPanel}`}>
              <div className={styles.panelHead}><span>GIT HISTORY</span><div className={styles.historyHeadingActions}><small>{historyLoading ? "READING REPOSITORY…" : `${historyCommitCount} COMMITS · ALL REFS`}</small><button type="button" aria-expanded={!historyCollapsed} aria-controls="sprintpilot-git-history" onClick={() => setHistoryCollapsed((collapsed) => !collapsed)}>{historyCollapsed ? "EXPAND" : "COLLAPSE"}</button></div></div>
              {!historyCollapsed && <div id="sprintpilot-git-history"><div className={styles.historyToolbar}><span>BRANCHES, MERGES, TAGS &amp; REMOTES</span><button disabled={!state.worktree || historyLoading} onClick={() => refreshHistory(0).catch((error) => setNotice(error.message))}>{historyLoading ? "REFRESHING…" : "REFRESH HISTORY"}</button></div><HistoryGraph lines={historyLines} hasMore={historyHasMore} loading={historyLoading} onLoadMore={() => refreshHistory(historyLines.filter((line) => line.kind === "commit").length, true).catch((error) => setNotice(error.message))}/></div>}
            </section>

            <section className={styles.panel}>
              <div className={styles.panelHead}><span>TEST LAB</span><small>.vscode/launch.json</small></div>
              <label className={styles.field}>TEST FILE<select value={state.testFile || ""} onChange={(event) => updateRuntime({ testFile: event.target.value })}><option value="">Select automation/tests file…</option>{testFiles.map((file) => <option key={file}>{file}</option>)}</select></label>
              <label className={styles.field}>LAUNCH CONFIG<select value={state.testPreset} onChange={(event) => updateRuntime({ testPreset: event.target.value, testOptions: [] })}>{TEST_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label>
              <p className={styles.hint}>{activePreset.description}</p>
              <div className={styles.args}>{activePreset.args.map((arg) => <code key={arg}>{arg}</code>)}</div>
              <div className={styles.options}>{activePreset.optionalArgs.map((option) => <label key={option.id}><input type="checkbox" checked={state.testOptions.includes(option.id)} onChange={(event) => {
                const withoutProvider = option.id === "saucelabs" || option.id === "browserstack"
                  ? state.testOptions.filter((id) => id !== "saucelabs" && id !== "browserstack")
                  : state.testOptions;
                updateRuntime({ testOptions: event.target.checked ? [...withoutProvider, option.id] : withoutProvider.filter((id) => id !== option.id) });
              }}/><span>{option.label}</span><small>disabled by default</small></label>)}</div>
              <button className={styles.primary} disabled={!state.testFile || !!busy} onClick={runTest}>{busy === "test" ? "RUNNING…" : "RUN SELECTED TEST"}</button>
            </section>

          </div>
        </>}
      </section>
    </div>
    {restartStep && <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setRestartStep(null); }}>
      <section className={styles.modal} role="alertdialog" aria-modal="true" aria-labelledby="restart-step-title">
        <span className={styles.modalKicker}>REPEAT WORKFLOW STEP</span>
        <h2 id="restart-step-title">Queue {restartStep} in the task chat?</h2>
        <p>{restartStep} is already marked complete for {task?.key}. It will run after the current task-agent work finishes, without creating another session.</p>
        {!state.worktree && <p className={styles.authError}>Create the task worktree before queuing work for the agent.</p>}
        <div className={styles.modalActions}><button disabled={!!busy} onClick={() => setRestartStep(null)}>CANCEL</button><button className={styles.primary} disabled={!state.worktree || !state.provider || !state.modelId || !!busy} onClick={restartCompletedStep}>{busy === restartStep ? "QUEUING…" : "QUEUE STEP"}</button></div>
      </section>
    </div>}
    {commitSetup && <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setCommitSetup(null); }}>
      <section className={`${styles.modal} ${styles.commitModal}`} role="dialog" aria-modal="true" aria-labelledby="commit-message-title">
        <span className={styles.modalKicker}>APPROVED SNAPSHOT</span>
        <h2 id="commit-message-title">Review commit message</h2>
        <p>The task agent used the exact approved snapshot and Jira details to explain the change. Edit it before committing if needed.</p>
        {commitSetup.phase === "loading" && <p className={styles.commitScan}>● DRAFTING FROM APPROVED CODE…</p>}
        {commitSetup.phase === "error" && <p className={styles.authError}>{commitSetup.error}</p>}
        {commitSetup.phase === "ready" && <><label>SUBJECT &amp; BODY<textarea autoFocus value={commitSetup.message} onChange={(event) => setCommitSetup({ ...commitSetup, message: event.target.value })}/></label><DraftProvenance origin={commitSetup}/></>}
        <div className={styles.modalActions}><button disabled={!!busy} onClick={() => setCommitSetup(null)}>CANCEL</button><button disabled={commitSetup.phase === "loading" || !!busy} onClick={() => prepareCommit()}>{busy === "commit-message" ? "DRAFTING…" : "REGENERATE"}</button><button className={styles.primary} disabled={commitSetup.phase !== "ready" || !commitSetup.message.trim() || !!busy} onClick={() => gitAction("commit", { message: commitSetup.message })}>{busy === "commit" ? "COMMITTING…" : "COMMIT APPROVED FILES"}</button></div>
      </section>
    </div>}
    {pullRequestSetup && <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setPullRequestSetup(null); }}>
      <section className={`${styles.modal} ${styles.commitModal}`} role="dialog" aria-modal="true" aria-labelledby="pr-metadata-title">
        <span className={styles.modalKicker}>AGENT-GENERATED PR METADATA</span>
        <h2 id="pr-metadata-title">Review pull request details</h2>
        <p>The task agent read the current diff and drafted this metadata. The repository title format is enforced before the PR is created.</p>
        {pullRequestSetup.phase === "loading" && <p className={styles.commitScan}>● DRAFTING FROM CURRENT CHANGES…</p>}
        {pullRequestSetup.phase === "error" && <p className={styles.authError}>{pullRequestSetup.error}</p>}
        {pullRequestSetup.phase === "ready" && <><label>PR TITLE<input autoFocus value={pullRequestSetup.title} onChange={(event) => setPullRequestSetup({ ...pullRequestSetup, title: event.target.value })}/></label><label>DESCRIPTION<textarea value={pullRequestSetup.description} onChange={(event) => setPullRequestSetup({ ...pullRequestSetup, description: event.target.value })}/></label><DraftProvenance origin={pullRequestSetup}/></>}
        <div className={styles.modalActions}><button disabled={!!busy} onClick={() => setPullRequestSetup(null)}>CANCEL</button><button disabled={pullRequestSetup.phase === "loading" || !!busy} onClick={() => preparePullRequest(pullRequestSetup.draft)}>{busy === "pr-metadata" ? "DRAFTING…" : "REGENERATE"}</button><button className={styles.primary} disabled={pullRequestSetup.phase !== "ready" || !pullRequestSetup.title.trim() || !pullRequestSetup.description.trim() || !!busy} onClick={async () => { if (await gitAction("pr", { draft: pullRequestSetup.draft, title: pullRequestSetup.title, description: pullRequestSetup.description })) setPullRequestSetup(null); }}>{busy === "pr" ? "OPENING…" : pullRequestSetup.draft ? "OPEN DRAFT PR" : "OPEN READY PR"}</button></div>
      </section>
    </div>}
    {ignoredStagePrompt && <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setIgnoredStagePrompt(null); }}>
      <section className={styles.modal} role="alertdialog" aria-modal="true" aria-labelledby="ignored-stage-title">
        <span className={styles.modalKicker}>IGNORED PATH</span>
        <h2 id="ignored-stage-title">Stage a file Git is set to ignore?</h2>
        <p>{ignoredStagePrompt.message}</p>
        <ul>{ignoredStagePrompt.files.map((file) => <li key={file}><code>{file}</code></li>)}</ul>
        <p>A tracked file inside an ignored directory needs this. An untracked one is ignored for a reason — check it is not a local secret before continuing.</p>
        <div className={styles.modalActions}>
          <button disabled={!!busy} onClick={() => setIgnoredStagePrompt(null)}>CANCEL</button>
          <button className={styles.primary} disabled={!!busy} onClick={() => { const files = ignoredStagePrompt.files; setIgnoredStagePrompt(null); void runStaging("stage", files, true); }}>STAGE ANYWAY</button>
        </div>
      </section>
    </div>}
    {deleteTarget && <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setDeleteTarget(null); }}>
      <section className={styles.modal} role="alertdialog" aria-modal="true" aria-labelledby="delete-worktree-title">
        <span className={styles.modalKicker}>DESTRUCTIVE ACTION</span>
        <h2 id="delete-worktree-title">Delete the {deleteTarget.key} worktree?</h2>
        <p>This removes the worktree directory but keeps its Git branch. Git will refuse deletion if the worktree has uncommitted changes.</p>
        <code>{deleteTarget.worktree}</code>
        <div className={styles.modalActions}><button disabled={!!busy} onClick={() => setDeleteTarget(null)}>CANCEL</button><button className={styles.danger} disabled={!!busy} onClick={deleteWorktree}>{busy === "delete-worktree" ? "DELETING…" : "YES, DELETE WORKTREE"}</button></div>
      </section>
    </div>}
    {createWorktreeSetup && <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setCreateWorktreeSetup(null); }}>
      <section className={`${styles.modal} ${styles.createWorktreeModal}`} role="dialog" aria-modal="true" aria-labelledby="create-worktree-title">
        <span className={styles.modalKicker}>SOURCE REPOSITORY</span>
        <h2 id="create-worktree-title">Create a worktree for {task?.key}</h2>
        <p>Choose the repository that owns this Jira task. The <strong>nir/</strong> branch and sibling worktree use the same Jira key and title slug, created from the latest <strong>origin/main</strong>.</p>
        {createWorktreeSetup.loading && <p className={styles.scanProgress}>● CHECKING REPOSITORIES…</p>}
        {createWorktreeSetup.error && <p className={styles.authError}>{createWorktreeSetup.error}</p>}
        {!createWorktreeSetup.loading && <div className={styles.worktreeSourceGrid}>
          {createWorktreeSetup.sources.map((source, index) => <button key={source.id} disabled={!source.available || !!busy} onClick={() => createWorktree({ source: source.id })}>
            <span>{String(index + 1).padStart(2, "0")}</span><b>{source.label}</b><small>{source.available ? source.path : "Repository not found"}</small><em>{source.available ? "CLONE FROM MAIN →" : "UNAVAILABLE"}</em>
          </button>)}
          <button disabled={!!busy} onClick={() => { setBrowseRepoInitialPath(createWorktreeSetup.sources[0]?.path); setCreateWorktreeSetup(null); setBrowseRepoError(undefined); setBrowseRepoOpen(true); }}>
            <span>04</span><b>OTHER</b><small>Browse to another local Git repository</small><em>BROWSE… →</em>
          </button>
        </div>}
        <div className={styles.modalActions}><button disabled={!!busy} onClick={() => setCreateWorktreeSetup(null)}>CANCEL</button></div>
      </section>
    </div>}
    {browseRepoOpen && <DirectoryPicker
      initialPath={browseRepoInitialPath}
      busy={busy === "worktree"}
      error={browseRepoError}
      onCancel={() => { if (!busy) { setBrowseRepoOpen(false); setBrowseRepoError(undefined); } }}
      onSelect={(repoRoot) => void createWorktree({ repoRoot })}
    />}
    {linkSetup && <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setLinkSetup(null); }}>
      <section className={`${styles.modal} ${styles.linkModal}`} role="dialog" aria-modal="true" aria-labelledby="link-worktree-title">
        <span className={styles.modalKicker}>EXISTING WORKTREE</span>
        <h2 id="link-worktree-title">Link a worktree to {linkSetup.key}?</h2>
        <p>SprintPilot scanned registered Git worktrees under <strong>~/git</strong>. Choose a match to use for this task. Linking does not change Git.</p>
        {linkSetup.loading && <p className={styles.scanProgress}>● SCANNING ~/git…</p>}
        {linkSetup.error && <p className={styles.authError}>{linkSetup.error}</p>}
        {!linkSetup.loading && !linkSetup.error && linkSetup.candidates.length === 0 && <p>No registered worktree matching {linkSetup.key} was found under ~/git.</p>}
        <div className={styles.candidateList}>{linkSetup.candidates.map((candidate) => <label className={styles.candidateOption} key={candidate.worktree}>
          <input type="radio" name="existing-worktree" value={candidate.worktree} checked={linkSetup.selected === candidate.worktree} onChange={() => setLinkSetup({ ...linkSetup, selected: candidate.worktree, error: undefined })}/>
          <span><strong>{candidate.branch || "Detached HEAD"}</strong><code>{candidate.worktree}</code></span>
        </label>)}</div>
        <div className={styles.modalActions}><button disabled={!!busy} onClick={() => setLinkSetup(null)}>CANCEL</button><button className={styles.primary} disabled={!linkSetup.selected || linkSetup.loading || !!busy} onClick={linkExistingWorktree}>{busy === "link-worktree" ? "LINKING…" : "LINK WORKTREE"}</button></div>
      </section>
    </div>}
    {authSetup && <div className={styles.modalBackdrop} role="presentation">
      <section className={`${styles.modal} ${styles.authModal}`} role="dialog" aria-modal="true" aria-labelledby="auth-title">
        <span className={styles.modalKicker}>PI PROVIDER AUTHORIZATION</span>
        <h2 id="auth-title">Connect {providerLabel(authSetup.provider)} to Pi</h2>
        {authSetup.phase === "connecting" && <p>{authSetup.message}</p>}
        {authSetup.phase === "auth" && <>
          <ol><li>Open the secure sign-in page below.</li><li>Sign in and approve access.</li><li>Copy the <b>entire callback URL</b> from the browser address bar after approval.</li><li>Paste it below and continue.</li></ol>
          <a className={styles.authLink} href={authSetup.url} target="_blank" rel="noreferrer">OPEN {providerLabel(authSetup.provider).toUpperCase()} SIGN-IN ↗</a>
          <label>CALLBACK URL OR AUTHORIZATION CODE<input autoFocus value={authSetup.input || ""} placeholder="Paste the complete callback URL here" onChange={(event) => setAuthSetup({ ...authSetup, input: event.target.value })}/></label>
        </>}
        {authSetup.phase === "device" && <><p>{authSetup.message}</p><strong className={styles.deviceCode}>{authSetup.userCode}</strong><a className={styles.authLink} href={authSetup.url} target="_blank" rel="noreferrer">OPEN VERIFICATION PAGE ↗</a></>}
        {authSetup.phase === "prompt" && <><p>{authSetup.message}</p><label>RESPONSE<input autoFocus value={authSetup.input || ""} onChange={(event) => setAuthSetup({ ...authSetup, input: event.target.value })}/></label></>}
        {authSetup.phase === "select" && <><p>{authSetup.message}</p><div className={styles.authOptions}>{authSetup.options?.map((option) => <button key={option.id} onClick={() => submitAuth(option.id)}>{option.label}</button>)}</div></>}
        {authSetup.phase === "progress" && <p className={styles.authProgress}>● {authSetup.message}</p>}
        {authSetup.phase === "success" && <p className={styles.authSuccess}>✓ {authSetup.message}</p>}
        {authSetup.phase === "error" && <p className={styles.authError}>{authSetup.message}</p>}
        <div className={styles.modalActions}>
          <button onClick={closeAuth}>{authSetup.phase === "success" ? "CLOSE" : "CANCEL"}</button>
          {(authSetup.phase === "auth" || authSetup.phase === "prompt") && <button className={styles.primary} disabled={!authSetup.input?.trim()} onClick={() => submitAuth(authSetup.input || "")}>CONTINUE</button>}
          {authSetup.phase === "success" && <button className={styles.primary} onClick={() => window.location.reload()}>REFRESH MODELS</button>}
          {authSetup.phase === "error" && <button className={styles.primary} onClick={() => connectProvider(authSetup.provider)}>TRY AGAIN</button>}
        </div>
      </section>
    </div>}
    {(notice || busy) && <div className={styles.noticeToast} role="status"><span>{busy ? `● RUNNING ${busy.toUpperCase()}` : notice}</span>{notice && !busy && <button aria-label="Dismiss notification" onClick={() => setNotice("")}>×</button>}</div>}
  </main>;
}

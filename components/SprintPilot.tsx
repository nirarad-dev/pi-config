"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/cjs/styles/prism";
import { completedStepsForJiraStatus, normalizeCompletedSteps, TEST_PRESETS, WORKFLOW_STEPS, type ModelEntry, type SprintTask, type WorkflowStep } from "@/lib/sprintpilot-config";
import { buildSprintPilotChangeTree, type SprintPilotChangeTreeNode } from "@/lib/sprintpilot-change-tree";
import { parseDiff } from "@/lib/sprintpilot-diff";
import type { SprintPilotHistoryLine } from "@/lib/sprintpilot-git-history";
import { sprintPilotDiffTokenStyles } from "@/lib/sprintpilot-highlight";
import { buildReviewFixPrompt, type ReviewComment } from "@/lib/sprintpilot-review";
import { sprintPilotDiffLanguage } from "@/lib/sprintpilot-syntax";
import type { ProviderRateLimits, SprintPilotUsage } from "@/lib/sprintpilot-usage";
import { FolderIcon, getFileIcon } from "./FileIcons";
import styles from "./SprintPilot.module.css";

const SPRINTPILOT_DIFF_THEME = { ...vscDarkPlus, ...sprintPilotDiffTokenStyles };
const HISTORY_PAGE_SIZE = 200;

type ModelResponse = {
  modelList?: ModelEntry[];
  defaultModel?: { provider: string; modelId: string } | null;
  thinkingLevels?: Record<string, string[]>;
};

type GitFile = { filePath: string; status: string };
type WorktreeCandidate = { key: string; worktree: string; branch?: string };
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
type CommitSetup = { phase: "loading" | "ready" | "error"; message: string; error?: string };
type TaskRuntime = {
  worktree?: string;
  branch?: string;
  provider?: string;
  modelId?: string;
  effort?: string;
  selectedFiles: string[];
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

const initialRuntime = (): TaskRuntime => ({ selectedFiles: [], testPreset: TEST_PRESETS[0].id, testOptions: [], completed: [], reviewComments: [] });
const COMPLETED_STEPS_KEY = "sprintpilot-completed-steps-v1";
const AGENT_STEPS: WorkflowStep[] = ["Plan", "Develop", "Pre-commit", "Deep review", "PR review"];
const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_EFFORT = "medium";

const actionPrompts: Record<string, (task: SprintTask) => string> = {
  Plan: (task) => `Plan ${task.key}: ${task.summary}. Inspect the worktree and produce a phased implementation plan. Do not edit files, commit, or push.`,
  Develop: (task) => `Implement ${task.key}: ${task.summary}. Follow the approved plan and repository guidance. Run focused checks, but do not stage, commit, push, or open a PR.`,
  Test: (task) => `Start a fresh testing session for ${task.key}: ${task.summary}. Inspect the current changes and identify or run the most relevant focused tests. Do not stage, commit, push, or open a PR.`,
  "Pre-commit": (task) => `Review the pending changes for ${task.key} before commit. Run the repository pre-commit checks and fix valid findings, but do not stage or commit anything.`,
  Approve: (task) => `Review the pending changes for ${task.key} and provide an approval recommendation with any blocking findings. Do not stage, commit, push, or open a PR.`,
  Commit: (task) => `Assess commit readiness for ${task.key}, summarize the exact intended files, and propose a commit message. Do not stage or commit anything.`,
  Push: (task) => `Assess push readiness for ${task.key}, including branch state and required checks. Do not push or make any Git writes.`,
  "Open PR": (task) => `Prepare a pull request title and description for ${task.key} from the current changes. Do not push or open the pull request.`,
  "Deep review": (task) => `Deep-review the pending ${task.key} changes at standard depth. Pin the current head, review with structured and holistic passes, then debunk every finding. Report only validated findings. Do not post, commit, or push.`,
  "PR review": (task) => `Run the PR-review workflow for ${task.key}: intake, triage, plan, then stop for approval before executing fixes. Preserve the workflow's hard approval gates. Do not commit, push, or post review replies without explicit approval.`,
};

function providerLabel(provider: string) {
  const value = provider.toLowerCase();
  if (value.includes("anthropic") || value.includes("claude")) return "Claude Code";
  if (value.includes("openai") || value.includes("codex")) return "Codex";
  return provider;
}

function isDefaultModel(model: ModelEntry) {
  return model.provider === DEFAULT_PROVIDER && model.id === DEFAULT_MODEL;
}

function preferredEffort(levels: Record<string, string[]>, model: ModelEntry) {
  const supported = levels[`${model.provider}:${model.id}`] || ["off"];
  return supported.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : supported[0];
}

function RateLimitBadge({ label, limits }: { label: string; limits?: ProviderRateLimits }) {
  const percentage = (value?: number) => value === undefined ? "—" : `${Math.round(value)}%`;
  const reset = (value?: string) => value ? new Date(value).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "No reset data";
  return <span className={styles.claudeUsageBadge}>
    <b>{label}</b>
    <span title={`Resets ${reset(limits?.fiveHour?.resetsAt)}`}><small>5H</small><strong>{percentage(limits?.fiveHour?.usedPercentage)}</strong></span>
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

function ChangeTree({
  nodes,
  collapsed,
  activePath,
  selectedPaths,
  onToggleDirectory,
  onOpenFile,
  onSelectFile,
}: {
  nodes: SprintPilotChangeTreeNode[];
  collapsed: Set<string>;
  activePath?: string;
  selectedPaths: Set<string>;
  onToggleDirectory: (path: string) => void;
  onOpenFile: (path: string) => void;
  onSelectFile: (path: string, selected: boolean) => void;
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
        {isOpen && <div className={styles.treeChildren}><ChangeTree nodes={node.children} collapsed={collapsed} activePath={activePath} selectedPaths={selectedPaths} onToggleDirectory={onToggleDirectory} onOpenFile={onOpenFile} onSelectFile={onSelectFile}/></div>}
      </div>;
    }

    const status = node.status.slice(0, 1).toUpperCase();
    return <div className={`${styles.fileRow} ${styles.treeFileRow} ${activePath === node.path ? styles.activeFile : ""}`} key={node.path}>
      <label className={styles.fileCheckbox} title={`Include ${node.path} in commit approval`}><input aria-label={`Include ${node.path} in commit approval`} type="checkbox" checked={selectedPaths.has(node.path)} onChange={(event) => onSelectFile(node.path, event.target.checked)}/></label>
      <button type="button" onClick={() => onOpenFile(node.path)} title={node.path}><span className={styles.treeFileIcon}>{getFileIcon(node.name, 15)}</span><span className={styles.fileIdentity}><b>{node.name}</b></span><em className={changeStatusClass(status)}>{status}</em></button>
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
  const [collapsedChangeFolders, setCollapsedChangeFolders] = useState<Set<string>>(() => new Set());
  const [developmentOpen, setDevelopmentOpen] = useState(true);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ key: string; worktree: string } | null>(null);
  const [linkSetup, setLinkSetup] = useState<LinkSetup | null>(null);
  const [restartStep, setRestartStep] = useState<WorkflowStep | null>(null);
  const [authSetup, setAuthSetup] = useState<AuthSetup | null>(null);
  const [commitSetup, setCommitSetup] = useState<CommitSetup | null>(null);
  const authEvents = useRef<EventSource | null>(null);
  const jiraSyncing = useRef(false);

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
    const availableFiles = new Set(git.files.map((file) => file.filePath.replace(`${state.worktree}/`, "")));
    if (state.selectedFiles.some((file) => !availableFiles.has(file))) {
      updateRuntime({ approvalToken: undefined, selectedFiles: state.selectedFiles.filter((file) => availableFiles.has(file)) });
    }
  }, [state.worktree, state.selectedFiles, updateRuntime]);

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
    setActiveKey(key);
  };

  const handleFlowStep = (step: WorkflowStep) => {
    if (state.completed.includes(step)) {
      setRestartStep(step);
      return;
    }
    const completed = normalizeCompletedSteps(state.completed, [step]);
    updateRuntime({ completed });
    setNotice(`${step} marked complete for ${task?.key}. Click it again to start a fresh Pi session.`);
  };

  const restartCompletedStep = async () => {
    if (!restartStep) return;
    const step = restartStep;
    setRestartStep(null);
    await runPiAction(step);
  };

  const runPiAction = async (step: WorkflowStep) => {
    if (!task || !state.worktree || !state.provider || !state.modelId || !actionPrompts[step]) return;
    setBusy(step);
    try {
      const result = await jsonRequest<{ sessionId: string }>("/api/agent/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: state.worktree, type: "prompt", message: actionPrompts[step](task), provider: state.provider, modelId: state.modelId, thinkingLevel: state.effort }),
      });
      updateRuntime({ sessionId: result.sessionId, completed: normalizeCompletedSteps(state.completed, [step]) });
      setNotice(`${step} started with ${providerLabel(state.provider)} · ${state.modelId} · ${state.effort}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const startDevelopmentSession = async () => {
    if (!task || !state.worktree || !state.provider || !state.modelId) return;
    setBusy("development-session");
    try {
      const result = await jsonRequest<{ sessionId: string }>("/api/agent/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: state.worktree, type: "ensure_session", provider: state.provider, modelId: state.modelId, thinkingLevel: state.effort }),
      });
      updateRuntime({ sessionId: result.sessionId });
      setDevelopmentOpen(true);
      setNotice(`Development conversation started for ${task.key}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const createWorktree = async () => {
    if (!task) return;
    setBusy("worktree");
    try {
      const result = await jsonRequest<{ worktree: string; branch: string }>("/api/sprintpilot/worktree", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(task),
      });
      updateRuntime(result);
      setNotice(`Fresh worktree created from origin/main: ${result.branch}`);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
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
      updateRuntime({ worktree: undefined, branch: undefined, sessionId: undefined, approvalToken: undefined, selectedFiles: [], completed: task ? completedStepsForJiraStatus(task.status) : [] });
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
      let sessionId = state.sessionId;
      if (!sessionId) {
        const result = await jsonRequest<{ sessionId: string }>("/api/agent/new", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd: state.worktree, type: "ensure_session", provider: state.provider, modelId: state.modelId, thinkingLevel: state.effort }),
        });
        sessionId = result.sessionId;
        updateRuntime({ sessionId });
        setDevelopmentOpen(true);
      }

      await jsonRequest(`/api/agent/${encodeURIComponent(sessionId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "prompt", message }),
      });

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

  const gitAction = async (action: "approve" | "commit" | "push" | "pr", extra: Record<string, unknown> = {}) => {
    if (!state.worktree || !task) return;
    setBusy(action);
    try {
      const result = await jsonRequest<{ approvalToken?: string; output?: string; url?: string }>("/api/sprintpilot/git", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, cwd: state.worktree, files: state.selectedFiles, approvalToken: state.approvalToken, title: `${task.key}: ${task.summary}`, ...extra }),
      });
      if (action === "approve") updateRuntime({ approvalToken: result.approvalToken, completed: normalizeCompletedSteps(state.completed, ["Approve"]) });
      if (action === "commit") {
        setCommitSetup(null);
        setActiveDiffFile(undefined);
        setDiff("");
        updateRuntime({ approvalToken: undefined, selectedFiles: [], completed: normalizeCompletedSteps(state.completed, ["Commit"]) });
        const refreshes = await Promise.allSettled([refreshWorkspace(), refreshHistory(0)]);
        const refreshFailure = refreshes.find((refresh) => refresh.status === "rejected");
        if (refreshFailure?.status === "rejected") {
          setNotice(`Commit complete, but the workspace refresh failed: ${refreshFailure.reason instanceof Error ? refreshFailure.reason.message : String(refreshFailure.reason)}`);
          return;
        }
      }
      if (action === "push") updateRuntime({ completed: normalizeCompletedSteps(state.completed, ["Push"]) });
      if (action === "pr") updateRuntime({ completed: normalizeCompletedSteps(state.completed, ["Open PR"]) });
      setNotice(result.url || result.output || (action === "approve" ? "Selection approved. The token expires in 30 minutes and becomes invalid if any selected file changes." : `${action} complete.`));
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(null); }
  };

  const prepareCommit = async () => {
    if (!state.worktree || !state.approvalToken || !task) return;
    setCommitSetup({ phase: "loading", message: "" });
    setBusy("commit-message");
    try {
      const result = await jsonRequest<{ message: string }>("/api/sprintpilot/git", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "commit-message", cwd: state.worktree, approvalToken: state.approvalToken, title: `${task.key}: ${task.summary}` }),
      });
      setCommitSetup({ phase: "ready", message: result.message });
    } catch (error) {
      setCommitSetup({ phase: "error", message: "", error: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  const providerGroups = useMemo(() => [...new Set(models.map((model) => model.provider))], [models]);
  const claudeConnected = authProviders.find((provider) => provider.id === "anthropic")?.loggedIn;
  const codexConnected = authProviders.find((provider) => provider.id === "openai-codex")?.loggedIn;
  const relativeGitFiles = useMemo(() => gitFiles.map((file) => ({
    source: file,
    relativePath: state.worktree ? file.filePath.replace(`${state.worktree}/`, "") : file.filePath,
  })), [gitFiles, state.worktree]);
  const changedFilePaths = relativeGitFiles.map((file) => file.relativePath);
  const changedFilesByPath = new Map(relativeGitFiles.map((file) => [file.relativePath, file.source]));
  const changeTree = useMemo(() => buildSprintPilotChangeTree(relativeGitFiles.map((file) => ({
    filePath: file.relativePath,
    status: file.source.status,
  }))), [relativeGitFiles]);
  const selectedFilePaths = new Set(state.selectedFiles);
  const activeDiffPath = activeDiffFile
    ? (state.worktree ? activeDiffFile.replace(`${state.worktree}/`, "") : activeDiffFile)
    : undefined;
  const pendingReviewComments = state.reviewComments.filter((comment) => !comment.sentAt);

  return <main className={styles.shell}>
    <header className={styles.topbar}>
      <div className={styles.brand}><span className={styles.mark}>π</span><div><strong>SPRINTPILOT</strong><small>CONTROL PLANE</small></div></div>
      <div className={styles.headerRight}>
        <span className={`${styles.jiraHealth} ${jiraConfigured ? styles.online : styles.warn}`}><i/>JIRA {jiraConfigured ? "LIVE" : "DEMO"}</span>
        <details className={styles.providerMenu}>
          <summary>PROVIDERS <span aria-hidden="true">⌄</span></summary>
          <div className={styles.providerPopover}>
            <div className={styles.providerStatus}><span><i className={claudeConnected ? styles.statusOnline : styles.statusOffline}/>CLAUDE</span><b>{claudeConnected ? "CONNECTED" : "OFFLINE"}</b></div>
            <div className={styles.providerStatus}><span><i className={codexConnected ? styles.statusOnline : styles.statusOffline}/>CODEX</span><b>{codexConnected ? "CONNECTED" : "OFFLINE"}</b></div>
            <div className={styles.usageRail} aria-label="Provider rate-limit usage"><span className={styles.usageWindow}>LIMITS</span><RateLimitBadge label="CLAUDE" limits={providerUsage?.claude.rateLimits}/><RateLimitBadge label="CODEX" limits={providerUsage?.codex.rateLimits}/></div>
            <a className={styles.providerConsoleLink} href="/chat">MODEL AUTH &amp; PI CONSOLE ↗</a>
          </div>
        </details>
      </div>
    </header>

    <div className={styles.layout}>
      <aside className={styles.sidebar}>
        <div className={styles.sectionLabel}>CURRENT SPRINT <span>{tasks.length}</span></div>
        <div className={styles.jiraSyncBar}><button disabled={jiraRefreshing} onClick={() => syncJiraTasks({ announce: true })}><span aria-hidden="true">↻</span>{jiraRefreshing ? "SYNCING JIRA…" : "REFRESH JIRA"}</button><small title={lastJiraSync ? `Last synced ${lastJiraSync.toLocaleString()}` : "Waiting for first sync"}>AUTO · 1 MIN{lastJiraSync ? ` · ${lastJiraSync.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}</small></div>
        {!jiraConfigured && <p className={styles.jiraWarning}><b>DEMO DATA</b> Jira is not connected. Copy <code>sprintpilot.env.example</code> to <code>.env.local</code>, add your Jira email and API token, then restart the app.</p>}
        <div className={styles.taskList}>{tasks.map((item) => <button key={item.key} className={`${styles.taskCard} ${item.key === activeKey ? styles.activeTask : ""}`} onClick={() => openTask(item.key)}>
          <span className={styles.taskMeta}><span className={styles.keyIdentity}><IssueTypeIcon type={item.issueType}/><b>{item.key}</b><small>{item.issueType || "Task"}</small></span><i>{item.priority}</i></span>
          {item.epicName && <span className={styles.taskEpic}><IssueTypeIcon epic/><b>EPIC</b><strong>{item.epicKey}</strong><span>{item.epicName}</span></span>}
          <span className={styles.taskTitle}>{item.summary}</span>
          <span className={styles.taskStatus}>{item.status}</span>
        </button>)}</div>
      </aside>

      <section className={styles.workspace}>
        <nav className={styles.tabs}>{openKeys.map((key) => <button key={key} onClick={() => setActiveKey(key)} className={key === activeKey ? styles.activeTab : ""}>{key}<span>×</span></button>)}</nav>
        {task && <>
          <div className={styles.taskHeader}>
            <div><span className={styles.eyebrow}><span><IssueTypeIcon type={task.issueType}/>{task.issueType || "Task"} {task.key}</span><span>{task.status}</span>{task.epicName && <span><IssueTypeIcon epic/>EPIC {task.epicKey} · {task.epicName}</span>}</span><h1>{task.summary}</h1><p>{state.worktree || "No worktree yet — create one from the latest origin/main before starting."}</p></div>
            {!state.worktree
              ? <div className={styles.worktreeActions}><button className={styles.primary} disabled={!!busy} onClick={createWorktree}>{busy === "worktree" ? "CREATING…" : "CREATE WORKTREE"}</button><button className={styles.secondary} disabled={!!busy} onClick={findExistingWorktrees}>LINK EXISTING WT</button></div>
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
            return <button type="button" key={step} className={completed ? styles.flowDone : ""} aria-pressed={completed} disabled={!!busy} title={completed ? `${step} is complete${jiraSynced ? ` from Jira status ${task.status}` : ""}. Click to start a new session.` : `Mark ${step} complete.`} onClick={() => handleFlowStep(step)}><span>{completed ? "✓" : String(index + 1).padStart(2, "0")}</span><b>{step}</b></button>;
          })}</div>
          <p className={styles.flowHint}>Click an incomplete step to mark it done. Completed steps open a new-session confirmation. Jira “In CR” completes Plan and Develop.</p>

          <div className={styles.grid}>
            <section className={`${styles.panel} ${styles.developmentPanel}`}>
              <div className={styles.panelHead}><span>DEVELOPMENT CONVERSATION</span><small>{state.sessionId ? `${providerLabel(state.provider || "")} · ${state.modelId}` : "TASK-SCOPED PI SESSION"}</small></div>
              {!state.worktree ? <div className={styles.developmentEmpty}><p>Link or create a worktree to start a development conversation for this Jira task.</p></div>
                : !state.sessionId ? <div className={styles.developmentEmpty}><p>Talk to the selected model without leaving SprintPilot. The session runs in this task&apos;s worktree and follows the current model and effort settings.</p><button className={styles.primary} disabled={!!busy || !state.provider || !state.modelId} onClick={startDevelopmentSession}>{busy === "development-session" ? "STARTING…" : "START DEVELOPMENT CONVERSATION"}</button></div>
                  : <><div className={styles.developmentToolbar}><span>● ACTIVE IN {state.worktree}</span><button onClick={() => setDevelopmentOpen((open) => !open)}>{developmentOpen ? "COLLAPSE" : "EXPAND"}</button><a href={`/chat?session=${encodeURIComponent(state.sessionId)}`}>OPEN FULL PI CHAT ↗</a></div>{developmentOpen && <iframe className={styles.developmentFrame} title={`${task.key} development conversation`} src={`/chat?session=${encodeURIComponent(state.sessionId)}&embedded=1&palette=sprintpilot`}/>}</>}
            </section>

            <section className={`${styles.panel} ${styles.changesPanel}`}>
              <div className={styles.panelHead}><span>REVIEW FILES &amp; APPROVE COMMIT</span><small className={state.approvalToken ? styles.approvedState : styles.pendingState}>{state.approvalToken ? `✓ ${state.selectedFiles.length} FILES APPROVED` : `${gitFiles.length} CHANGED · NOT APPROVED`}</small></div>
              <div className={styles.reviewTools}><button disabled={!gitFiles.length || !!busy} onClick={() => updateRuntime({ approvalToken: undefined, selectedFiles: changedFilePaths })}>SELECT ALL</button><button disabled={!state.selectedFiles.length || !!busy} onClick={() => updateRuntime({ approvalToken: undefined, selectedFiles: [] })}>CLEAR</button><button disabled={!state.worktree || !!busy} onClick={() => refreshWorkspace().then(() => setNotice("Pending changes refreshed.")).catch((error) => setNotice(error.message))}>REFRESH CHANGES</button><span>{state.selectedFiles.length} OF {gitFiles.length} SELECTED</span></div>
              <div className={styles.changeLayout}>
                <div className={styles.fileExplorer}><div className={styles.explorerHead}><span>CHANGES</span><b>{gitFiles.length}</b></div><div className={styles.fileList}>{gitFiles.length ? <ChangeTree
                  nodes={changeTree}
                  collapsed={collapsedChangeFolders}
                  activePath={activeDiffPath}
                  selectedPaths={selectedFilePaths}
                  onToggleDirectory={(path) => setCollapsedChangeFolders((current) => {
                    const next = new Set(current);
                    if (next.has(path)) next.delete(path);
                    else next.add(path);
                    return next;
                  })}
                  onOpenFile={(path) => {
                    const file = changedFilesByPath.get(path);
                    if (file) void inspectDiff(file);
                  }}
                  onSelectFile={(path, selected) => updateRuntime({ approvalToken: undefined, selectedFiles: selected ? [...state.selectedFiles, path] : state.selectedFiles.filter((item) => item !== path) })}
                /> : <p className={styles.empty}>{state.worktree ? "No pending changes detected. Use Refresh changes after the development session edits files." : "Link or create a worktree to review its files."}</p>}</div></div>
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
              <div className={styles.approvalNote}>{state.approvalToken ? <span className={styles.approvedState}>✓ Approval is bound to the selected file contents for 30 minutes.</span> : <span>Select files, inspect their patches, then approve their exact contents before commit is enabled.</span>}</div>
              <div className={styles.gitGates}>
                <button disabled={!state.selectedFiles.length || !!busy} onClick={() => gitAction("approve")}>1 · APPROVE FILES FOR COMMIT</button>
                <button disabled={!state.approvalToken || !!busy} onClick={prepareCommit}>2 · REVIEW COMMIT MESSAGE</button>
                <button disabled={!state.worktree || !!busy} onClick={() => gitAction("push")}>3 · PUSH BRANCH</button>
                <div className={styles.prSplit}><button disabled={!state.worktree || !!busy} onClick={() => gitAction("pr", { draft: true })}>4A · OPEN DRAFT PR</button><button disabled={!state.worktree || !!busy} onClick={() => gitAction("pr", { draft: false })}>4B · OPEN READY PR</button></div>
              </div>
            </section>

            <section className={`${styles.panel} ${styles.historyPanel}`}>
              <div className={styles.panelHead}><span>GIT HISTORY</span><small>{historyLoading ? "READING REPOSITORY…" : `${historyCommitCount} COMMITS · ALL REFS`}</small></div>
              <div className={styles.historyToolbar}><span>BRANCHES, MERGES, TAGS &amp; REMOTES</span><button disabled={!state.worktree || historyLoading} onClick={() => refreshHistory(0).catch((error) => setNotice(error.message))}>{historyLoading ? "REFRESHING…" : "REFRESH HISTORY"}</button></div>
              <HistoryGraph lines={historyLines} hasMore={historyHasMore} loading={historyLoading} onLoadMore={() => refreshHistory(historyLines.filter((line) => line.kind === "commit").length, true).catch((error) => setNotice(error.message))}/>
            </section>

            <section className={styles.panel}>
              <div className={styles.panelHead}><span>AUTONOMOUS WORK</span><small>PI SESSION · NO GIT WRITES</small></div>
              <div className={styles.actionGrid}>{AGENT_STEPS.map((step) => <button key={step} disabled={!state.worktree || !!busy} onClick={() => runPiAction(step)}><span>{step}</span><small>{step === "PR review" ? "approval-gated" : "launch agent"}</small></button>)}</div>
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
        <span className={styles.modalKicker}>COMPLETED STEP</span>
        <h2 id="restart-step-title">Start a new {restartStep} session?</h2>
        <p>{restartStep} is already marked complete for {task?.key}. Starting again creates a separate Pi session and keeps the step completed.</p>
        {!state.worktree && <p className={styles.authError}>Create the task worktree before starting a Pi session.</p>}
        <div className={styles.modalActions}><button disabled={!!busy} onClick={() => setRestartStep(null)}>CANCEL</button><button className={styles.primary} disabled={!state.worktree || !state.provider || !state.modelId || !!busy} onClick={restartCompletedStep}>START NEW SESSION</button></div>
      </section>
    </div>}
    {commitSetup && <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setCommitSetup(null); }}>
      <section className={`${styles.modal} ${styles.commitModal}`} role="dialog" aria-modal="true" aria-labelledby="commit-message-title">
        <span className={styles.modalKicker}>APPROVED SNAPSHOT</span>
        <h2 id="commit-message-title">Review commit message</h2>
        <p>The draft was generated from the exact files you approved. Edit it before committing if needed.</p>
        {commitSetup.phase === "loading" && <p className={styles.commitScan}>● SCANNING APPROVED CODE…</p>}
        {commitSetup.phase === "error" && <p className={styles.authError}>{commitSetup.error}</p>}
        {commitSetup.phase === "ready" && <label>SUBJECT &amp; BODY<textarea autoFocus value={commitSetup.message} onChange={(event) => setCommitSetup({ ...commitSetup, message: event.target.value })}/></label>}
        <div className={styles.modalActions}><button disabled={!!busy} onClick={() => setCommitSetup(null)}>CANCEL</button><button className={styles.primary} disabled={commitSetup.phase !== "ready" || !commitSetup.message.trim() || !!busy} onClick={() => gitAction("commit", { message: commitSetup.message })}>{busy === "commit" ? "COMMITTING…" : "COMMIT APPROVED FILES"}</button></div>
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

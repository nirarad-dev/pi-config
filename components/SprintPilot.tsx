"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TEST_PRESETS, WORKFLOW_STEPS, type ModelEntry, type SprintTask } from "@/lib/sprintpilot-config";
import styles from "./SprintPilot.module.css";

type ModelResponse = {
  modelList?: ModelEntry[];
  defaultModel?: { provider: string; modelId: string } | null;
  thinkingLevels?: Record<string, string[]>;
};

type GitFile = { filePath: string; status: string };
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
  completed: string[];
};

const DEMO_TASKS: SprintTask[] = [
  { key: "DEV-4821", issueType: "Story", summary: "Harden transaction policy evaluation", status: "In Progress", priority: "High", epicKey: "DEV-4700", epicName: "Policy engine hardening" },
  { key: "DEV-4798", issueType: "Task", summary: "Add wallet recovery audit trail", status: "Selected", priority: "Medium", epicKey: "DEV-4650", epicName: "Recovery controls" },
  { key: "DEV-4762", issueType: "Bug", summary: "Fix mobile signing timeout", status: "Review", priority: "Critical", epicKey: "DEV-4720", epicName: "Mobile signing reliability" },
  { key: "DEV-4840", issueType: "Task", summary: "Expose vault health diagnostics", status: "To Do", priority: "Low", epicKey: "DEV-4800", epicName: "Operational visibility" },
];

const initialRuntime = (): TaskRuntime => ({ selectedFiles: [], testPreset: TEST_PRESETS[0].id, testOptions: [], completed: [] });

const actionPrompts: Record<string, (task: SprintTask) => string> = {
  Plan: (task) => `Plan ${task.key}: ${task.summary}. Inspect the worktree and produce a phased implementation plan. Do not edit files, commit, or push.`,
  Develop: (task) => `Implement ${task.key}: ${task.summary}. Follow the approved plan and repository guidance. Run focused checks, but do not stage, commit, push, or open a PR.`,
  "Pre-commit": (task) => `Review the pending changes for ${task.key} before commit. Run the repository pre-commit checks and fix valid findings, but do not stage or commit anything.`,
  "Deep review": (task) => `Deep-review the pending ${task.key} changes at standard depth. Pin the current head, review with structured and holistic passes, then debunk every finding. Report only validated findings. Do not post, commit, or push.`,
  "PR review": (task) => `Run the PR-review workflow for ${task.key}: intake, triage, plan, then stop for approval before executing fixes. Preserve the workflow's hard approval gates. Do not commit, push, or post review replies without explicit approval.`,
};

function providerLabel(provider: string) {
  const value = provider.toLowerCase();
  if (value.includes("anthropic") || value.includes("claude")) return "Claude Code";
  if (value.includes("openai") || value.includes("codex")) return "Codex";
  return provider;
}

function isCompletedTask(task: SprintTask) {
  if (task.statusCategory?.toLowerCase() === "done") return true;
  return /^(done|closed|resolved|completed|cancelled|canceled)$/i.test(task.status.trim());
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
  const [openKeys, setOpenKeys] = useState<string[]>([DEMO_TASKS[0].key]);
  const [activeKey, setActiveKey] = useState(DEMO_TASKS[0].key);
  const [runtime, setRuntime] = useState<Record<string, TaskRuntime>>({ [DEMO_TASKS[0].key]: initialRuntime() });
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [thinkingLevels, setThinkingLevels] = useState<Record<string, string[]>>({});
  const [authProviders, setAuthProviders] = useState<AuthProvider[]>([]);
  const [gitFiles, setGitFiles] = useState<GitFile[]>([]);
  const [testFiles, setTestFiles] = useState<string[]>([]);
  const [diff, setDiff] = useState("Select a changed file to inspect its patch.");
  const [notice, setNotice] = useState("Ready. Every write action requires a deliberate click.");
  const [busy, setBusy] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ key: string; worktree: string } | null>(null);
  const [authSetup, setAuthSetup] = useState<AuthSetup | null>(null);
  const authEvents = useRef<EventSource | null>(null);

  const task = tasks.find((candidate) => candidate.key === activeKey) || tasks[0];
  const storedState = runtime[activeKey] || initialRuntime();
  const fallbackModel = models[0];
  const state: TaskRuntime = {
    ...storedState,
    provider: storedState.provider || fallbackModel?.provider,
    modelId: storedState.modelId || fallbackModel?.id,
    effort: storedState.effort || (fallbackModel ? (thinkingLevels[`${fallbackModel.provider}:${fallbackModel.id}`] || ["off"])[0] : "off"),
  };
  const activePreset = TEST_PRESETS.find((preset) => preset.id === state.testPreset) || TEST_PRESETS[0];
  const modelKey = state.provider && state.modelId ? `${state.provider}:${state.modelId}` : "";
  const effortOptions = thinkingLevels[modelKey] || ["off"];

  const updateRuntime = useCallback((patch: Partial<TaskRuntime>) => {
    setRuntime((current) => ({ ...current, [activeKey]: { ...(current[activeKey] || initialRuntime()), ...patch } }));
  }, [activeKey]);

  useEffect(() => {
    Promise.all([
      jsonRequest<{ configured: boolean; tasks: SprintTask[] }>("/api/sprintpilot/tasks"),
      jsonRequest<{ worktrees: { key: string; worktree: string; branch?: string }[] }>("/api/sprintpilot/worktree"),
    ]).then(([jira, worktreeData]) => {
        setJiraConfigured(jira.configured);
        const loadedTasks = jira.configured ? jira.tasks.filter((loadedTask) => !isCompletedTask(loadedTask)) : DEMO_TASKS;
        const worktrees = new Map(worktreeData.worktrees.map((entry) => [entry.key, entry]));
        setTasks(loadedTasks);
        setOpenKeys(loadedTasks[0] ? [loadedTasks[0].key] : []);
        if (loadedTasks[0]) setActiveKey(loadedTasks[0].key);
        setRuntime(Object.fromEntries(loadedTasks.map((loadedTask) => [loadedTask.key, {
          ...initialRuntime(),
          ...worktrees.get(loadedTask.key),
        }])));
      })
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
        const preferred = available.find((model) => model.provider === data.defaultModel?.provider && model.id === data.defaultModel?.modelId) || available[0];
        if (preferred) {
          setRuntime((current) => Object.fromEntries(Object.entries(current).map(([key, value]) => [key, {
            ...value,
            provider: value.provider || preferred.provider,
            modelId: value.modelId || preferred.id,
            effort: value.effort || (data.thinkingLevels?.[`${preferred.provider}:${preferred.id}`] || ["off"])[0],
          }])));
        }
      })
      .catch((error) => setNotice(error.message));
    return () => authEvents.current?.close();
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

  useEffect(() => {
    if (!state.worktree) {
      setGitFiles([]);
      setTestFiles([]);
      return;
    }
    Promise.all([
      jsonRequest<{ files: GitFile[] }>(`/api/git/status?cwd=${encodeURIComponent(state.worktree)}`),
      jsonRequest<{ files: string[] }>(`/api/sprintpilot/tests?cwd=${encodeURIComponent(state.worktree)}`),
    ]).then(([git, tests]) => {
      setGitFiles(git.files);
      setTestFiles(tests.files);
    }).catch((error) => setNotice(error.message));
  }, [state.worktree, activeKey]);

  const openTask = (key: string) => {
    setOpenKeys((keys) => keys.includes(key) ? keys : [...keys, key]);
    setRuntime((current) => current[key] ? current : { ...current, [key]: initialRuntime() });
    setActiveKey(key);
  };

  const runPiAction = async (step: string) => {
    if (!task || !state.worktree || !state.provider || !state.modelId || !actionPrompts[step]) return;
    setBusy(step);
    try {
      const result = await jsonRequest<{ sessionId: string }>("/api/agent/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: state.worktree, type: "prompt", message: actionPrompts[step](task), provider: state.provider, modelId: state.modelId, thinkingLevel: state.effort }),
      });
      updateRuntime({ sessionId: result.sessionId, completed: [...new Set([...state.completed, step])] });
      setNotice(`${step} started with ${providerLabel(state.provider)} · ${state.modelId} · ${state.effort}.`);
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

  const deleteWorktree = async () => {
    if (!deleteTarget) return;
    setBusy("delete-worktree");
    try {
      await jsonRequest("/api/sprintpilot/worktree", {
        method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: deleteTarget.worktree }),
      });
      updateRuntime({ worktree: undefined, branch: undefined, sessionId: undefined, approvalToken: undefined, selectedFiles: [], completed: [] });
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
    const result = await jsonRequest<{ supported: boolean; patch?: string }>(`/api/git/diff?cwd=${encodeURIComponent(state.worktree)}&path=${encodeURIComponent(file.filePath)}`);
    setDiff(result.supported && result.patch ? result.patch : "Binary or oversized diff; inspect it in the Pi workspace.");
  };

  const runTest = async () => {
    if (!state.worktree || !state.testFile) return;
    setBusy("test"); setNotice("Test running… output will appear here when it finishes.");
    try {
      const result = await jsonRequest<{ output: string }>("/api/sprintpilot/tests", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: state.worktree, file: state.testFile, preset: state.testPreset, options: state.testOptions }),
      });
      updateRuntime({ completed: [...new Set([...state.completed, "Test"])] });
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
      if (action === "approve") updateRuntime({ approvalToken: result.approvalToken, completed: [...new Set([...state.completed, "Approve"])] });
      if (action === "commit") updateRuntime({ approvalToken: undefined, completed: [...new Set([...state.completed, "Commit"])] });
      if (action === "push") updateRuntime({ completed: [...new Set([...state.completed, "Push"])] });
      if (action === "pr") updateRuntime({ completed: [...new Set([...state.completed, "Open PR"])] });
      setNotice(result.url || result.output || (action === "approve" ? "Selection approved. The token expires in 30 minutes and becomes invalid if any selected file changes." : `${action} complete.`));
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(null); }
  };

  const providerGroups = useMemo(() => [...new Set(models.map((model) => model.provider))], [models]);
  const claudeConnected = authProviders.find((provider) => provider.id === "anthropic")?.loggedIn;
  const codexConnected = authProviders.find((provider) => provider.id === "openai-codex")?.loggedIn;

  return <main className={styles.shell}>
    <header className={styles.topbar}>
      <div className={styles.brand}><span className={styles.mark}>π</span><div><strong>SPRINTPILOT</strong><small>CONTROL PLANE</small></div></div>
      <div className={styles.connections}>
        <span className={jiraConfigured ? styles.online : styles.warn}>● JIRA {jiraConfigured ? "LIVE" : "DEMO"}</span>
        <span className={claudeConnected ? styles.online : styles.warn}>● CLAUDE {claudeConnected ? "CONNECTED" : "OFFLINE"}</span>
        <span className={codexConnected ? styles.online : styles.warn}>● CODEX {codexConnected ? "CONNECTED" : "OFFLINE"}</span>
        <a href="/chat">MODEL AUTH & PI CONSOLE ↗</a>
      </div>
    </header>

    <div className={styles.layout}>
      <aside className={styles.sidebar}>
        <div className={styles.sectionLabel}>CURRENT SPRINT <span>{tasks.length}</span></div>
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
              ? <button className={styles.primary} disabled={!!busy} onClick={createWorktree}>{busy === "worktree" ? "CREATING…" : "CREATE WORKTREE"}</button>
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

          <div className={styles.flow}>{WORKFLOW_STEPS.map((step, index) => <div key={step} className={state.completed.includes(step) ? styles.flowDone : ""}><span>{String(index + 1).padStart(2, "0")}</span><b>{step}</b></div>)}</div>

          <div className={styles.grid}>
            <section className={styles.panel}>
              <div className={styles.panelHead}><span>AUTONOMOUS WORK</span><small>PI SESSION · NO GIT WRITES</small></div>
              <div className={styles.actionGrid}>{["Plan", "Develop", "Pre-commit", "Deep review", "PR review"].map((step) => <button key={step} disabled={!state.worktree || !!busy} onClick={() => runPiAction(step)}><span>{step}</span><small>{step === "PR review" ? "approval-gated" : "launch agent"}</small></button>)}</div>
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

            <section className={`${styles.panel} ${styles.changesPanel}`}>
              <div className={styles.panelHead}><span>PENDING CHANGES</span><small>{gitFiles.length} FILES · APPROVAL BOUND TO CONTENT</small></div>
              <div className={styles.changeLayout}><div className={styles.fileList}>{gitFiles.length ? gitFiles.map((file) => {
                const relative = state.worktree ? file.filePath.replace(`${state.worktree}/`, "") : file.filePath;
                return <label key={file.filePath}><input type="checkbox" checked={state.selectedFiles.includes(relative)} onChange={(event) => updateRuntime({ approvalToken: undefined, selectedFiles: event.target.checked ? [...state.selectedFiles, relative] : state.selectedFiles.filter((item) => item !== relative) })}/><button onClick={() => inspectDiff(file)}><b>{file.status.slice(0, 1).toUpperCase()}</b><span>{relative}</span></button></label>;
              }) : <p className={styles.empty}>No pending changes detected.</p>}</div><pre className={styles.diff}>{diff}</pre></div>
              <div className={styles.gitGates}>
                <button disabled={!state.selectedFiles.length || !!busy} onClick={() => gitAction("approve")}>1 · APPROVE SELECTED</button>
                <button disabled={!state.approvalToken || !!busy} onClick={() => gitAction("commit", { message: `${task.key}: ${task.summary}` })}>2 · COMMIT</button>
                <button disabled={!state.worktree || !!busy} onClick={() => gitAction("push")}>3 · PUSH BRANCH</button>
                <div className={styles.prSplit}><button disabled={!state.worktree || !!busy} onClick={() => gitAction("pr", { draft: true })}>4A · OPEN DRAFT PR</button><button disabled={!state.worktree || !!busy} onClick={() => gitAction("pr", { draft: false })}>4B · OPEN READY PR</button></div>
              </div>
            </section>
          </div>
        </>}
      </section>
    </div>
    {deleteTarget && <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setDeleteTarget(null); }}>
      <section className={styles.modal} role="alertdialog" aria-modal="true" aria-labelledby="delete-worktree-title">
        <span className={styles.modalKicker}>DESTRUCTIVE ACTION</span>
        <h2 id="delete-worktree-title">Delete the {deleteTarget.key} worktree?</h2>
        <p>This removes the worktree directory but keeps its Git branch. Git will refuse deletion if the worktree has uncommitted changes.</p>
        <code>{deleteTarget.worktree}</code>
        <div className={styles.modalActions}><button disabled={!!busy} onClick={() => setDeleteTarget(null)}>CANCEL</button><button className={styles.danger} disabled={!!busy} onClick={deleteWorktree}>{busy === "delete-worktree" ? "DELETING…" : "YES, DELETE WORKTREE"}</button></div>
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
    <footer className={styles.console}><span>EVENT LOG</span><pre>{notice}</pre><b>{busy ? `RUNNING ${busy.toUpperCase()}` : "IDLE"}</b></footer>
  </main>;
}

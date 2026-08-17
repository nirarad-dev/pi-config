import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type JiraParent = { key?: string; fields?: { summary?: string } };
type JiraFields = {
  summary?: string;
  description?: unknown;
  status?: { name?: string; statusCategory?: { key?: string } };
  priority?: { name?: string };
  assignee?: { displayName?: string };
  issuetype?: { name?: string; subtask?: boolean };
  parent?: JiraParent;
  [field: string]: unknown;
};
type JiraIssue = { key: string; fields?: JiraFields };

function jiraDescription(value: unknown): string | undefined {
  const parts: string[] = [];
  const visit = (entry: unknown) => {
    if (typeof entry === "string") { parts.push(entry); return; }
    if (!entry || typeof entry !== "object") return;
    const node = entry as { text?: unknown; content?: unknown };
    if (typeof node.text === "string") parts.push(node.text);
    if (Array.isArray(node.content)) node.content.forEach(visit);
  };
  visit(value);
  const description = parts.join(" ").replace(/\s+/g, " ").trim();
  return description || undefined;
}

export async function GET() {
  const baseUrl = process.env.JIRA_BASE_URL?.replace(/\/$/, "");
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  if (!baseUrl || !email || !token) {
    return NextResponse.json({ configured: false, tasks: [], error: "Set JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN." });
  }

  const jql = process.env.JIRA_JQL || "assignee = currentUser() AND sprint in openSprints() AND statusCategory != Done ORDER BY Rank ASC";
  const legacyEpicLinkField = process.env.JIRA_EPIC_LINK_FIELD;
  const headers = {
    Accept: "application/json",
    Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
  };
  const fields = ["summary", "description", "status", "priority", "assignee", "issuetype", "parent", legacyEpicLinkField].filter(Boolean).join(",");
  const issues: JiraIssue[] = [];
  const seenTokens = new Set<string>();
  let nextPageToken: string | undefined;
  do {
    const url = new URL(`${baseUrl}/rest/api/3/search/jql`);
    url.searchParams.set("jql", jql);
    url.searchParams.set("fields", fields);
    url.searchParams.set("maxResults", "100");
    if (nextPageToken) url.searchParams.set("nextPageToken", nextPageToken);
    const response = await fetch(url, { headers, cache: "no-store" });
    if (!response.ok) {
      return NextResponse.json({ configured: true, tasks: [], error: `Jira returned ${response.status}` }, { status: 502 });
    }
    const page = await response.json() as { issues?: JiraIssue[]; nextPageToken?: string; isLast?: boolean };
    issues.push(...(page.issues || []));
    nextPageToken = page.isLast ? undefined : page.nextPageToken;
    if (nextPageToken && seenTokens.has(nextPageToken)) {
      return NextResponse.json({ configured: true, tasks: [], error: "Jira pagination returned a repeated token" }, { status: 502 });
    }
    if (nextPageToken) seenTokens.add(nextPageToken);
  } while (nextPageToken);
  const issueCache = new Map<string, JiraIssue>();
  const loadIssue = async (key: string) => {
    const cached = issueCache.get(key);
    if (cached) return cached;
    const issueUrl = new URL(`${baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}`);
    issueUrl.searchParams.set("fields", "summary,parent");
    const issueResponse = await fetch(issueUrl, { headers, cache: "no-store" });
    if (!issueResponse.ok) return undefined;
    const loaded = await issueResponse.json() as JiraIssue;
    issueCache.set(key, loaded);
    return loaded;
  };

  const tasks = await Promise.all(issues.map(async (issue) => {
    const fields = issue.fields;
    let epic = fields?.parent;
    if (fields?.issuetype?.subtask && epic?.key) {
      epic = (await loadIssue(epic.key))?.fields?.parent;
    }
    const legacyEpicKey = legacyEpicLinkField && typeof fields?.[legacyEpicLinkField] === "string"
      ? fields[legacyEpicLinkField]
      : undefined;
    if (!epic?.key && legacyEpicKey) epic = { key: legacyEpicKey };
    if (epic?.key && !epic.fields?.summary) {
      const loadedEpic = await loadIssue(epic.key);
      if (loadedEpic) epic = { key: loadedEpic.key, fields: { summary: loadedEpic.fields?.summary } };
    }
    return {
      key: issue.key,
      summary: String(fields?.summary || "Untitled Jira issue"),
      description: jiraDescription(fields?.description),
      status: String(fields?.status?.name || "Unknown"),
      statusCategory: fields?.status?.statusCategory?.key,
      priority: String(fields?.priority?.name || "Normal"),
      assignee: fields?.assignee?.displayName ? String(fields.assignee.displayName) : undefined,
      issueType: String(fields?.issuetype?.name || "Task"),
      epicKey: epic?.key,
      epicName: epic?.fields?.summary,
    };
  }));
  return NextResponse.json({ configured: true, tasks });
}

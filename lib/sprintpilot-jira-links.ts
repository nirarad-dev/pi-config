export type SprintPilotJiraDevelopmentResult =
  | { state: "linked" }
  | { state: "pending" }
  | { state: "unavailable"; error: string };

function jiraCredentials() {
  const baseUrl = process.env.JIRA_BASE_URL?.replace(/\/$/, "");
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  return baseUrl && email && token ? { baseUrl, email, token } : undefined;
}

function authHeaders(credentials: { email: string; token: string }) {
  return {
    Accept: "application/json",
    Authorization: `Basic ${Buffer.from(`${credentials.email}:${credentials.token}`).toString("base64")}`,
  };
}

/**
 * Attach a remote link on the issue pointing at the pull request.
 *
 * This is not a substitute for the Development panel — a remote link appears
 * under issue links and creates none of the branch/PR association GitHub for
 * Atlassian maintains. It is the fallback that leaves a visible, clickable link
 * on the ticket when DevInfo ingest silently does not happen, which is the
 * failure that left a correct-looking PR invisible from Jira
 * (JSWCLOUD-21862). Reported, never fatal: the PR already exists by this point,
 * and failing the action would misrepresent that.
 */
export async function createSprintPilotJiraRemoteLink(taskKey: string, url: string, title: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const credentials = jiraCredentials();
  if (!credentials) return { ok: false, error: "Jira remote linking is not configured" };
  try {
    const response = await fetch(`${credentials.baseUrl}/rest/api/3/issue/${encodeURIComponent(taskKey)}/remotelink`, {
      method: "POST",
      headers: { ...authHeaders(credentials), "Content-Type": "application/json" },
      // globalId makes the call idempotent, so re-running the check or opening a
      // replacement PR updates the existing link instead of stacking duplicates.
      body: JSON.stringify({
        globalId: `sprintpilot-pr=${url}`,
        application: { type: "com.github", name: "GitHub" },
        relationship: "mentioned in",
        object: { url, title, icon: { url16x16: "https://github.githubassets.com/favicon.ico", title: "GitHub" } },
      }),
      cache: "no-store",
    });
    if (!response.ok) return { ok: false, error: `Jira returned ${response.status} while creating the remote link` };
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not reach Jira to create the remote link" };
  }
}

/**
 * Check Jira's native Development data. A Jira remote link is intentionally not
 * used as the signal here: it appears under issue links, but it does not create
 * the branch/PR association maintained by GitHub for Atlassian. Only a
 * pullrequest entry in Development data means Jira has actually ingested it.
 */
export async function checkSprintPilotPullRequestInJira(taskKey: string): Promise<SprintPilotJiraDevelopmentResult> {
  const credentials = jiraCredentials();
  if (!credentials) return { state: "unavailable", error: "Jira development-link verification is not configured" };
  try {
    const query = new URLSearchParams({
      jql: `key = "${taskKey}" AND development[pullrequests].all > 0`,
      fields: "key",
      maxResults: "1",
    });
    const response = await fetch(`${credentials.baseUrl}/rest/api/3/search/jql?${query}`, {
      headers: authHeaders(credentials),
      cache: "no-store",
    });
    if (!response.ok) return { state: "unavailable", error: `Jira returned ${response.status} while checking Development data` };
    const result = await response.json() as { issues?: unknown[] };
    return result.issues?.length ? { state: "linked" } : { state: "pending" };
  } catch {
    return { state: "unavailable", error: "Could not reach Jira to verify the Development link" };
  }
}

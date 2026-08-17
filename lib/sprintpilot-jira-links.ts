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

/**
 * Check Jira's native Development data. A Jira remote link is intentionally not
 * used here: it appears under issue links, but it does not create the branch/PR
 * association maintained by GitHub for Atlassian.
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
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(`${credentials.email}:${credentials.token}`).toString("base64")}`,
      },
      cache: "no-store",
    });
    if (!response.ok) return { state: "unavailable", error: `Jira returned ${response.status} while checking Development data` };
    const result = await response.json() as { issues?: unknown[] };
    return result.issues?.length ? { state: "linked" } : { state: "pending" };
  } catch {
    return { state: "unavailable", error: "Could not reach Jira to verify the Development link" };
  }
}

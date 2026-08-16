import { readFile, readdir, stat } from "fs/promises";
import { join } from "path";
import { getAgentDir, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { aggregateSprintPilotUsage, normalizeClaudeRateLimits, type ClaudeRateLimits } from "@/lib/sprintpilot-usage";

export const dynamic = "force-dynamic";

const WINDOW_MS = 7 * 24 * 60 * 60_000;
const CLAUDE_CACHE_MS = 5 * 60_000;

type ClaudeUsageCache = { attemptedAt: number; value?: ClaudeRateLimits; inFlight?: Promise<ClaudeRateLimits | undefined> };
declare global { var __sprintPilotClaudeUsage: ClaudeUsageCache | undefined; }

async function claudeRateLimits() {
  globalThis.__sprintPilotClaudeUsage ||= { attemptedAt: 0 };
  const cache = globalThis.__sprintPilotClaudeUsage;
  if (Date.now() - cache.attemptedAt < CLAUDE_CACHE_MS) return cache.value;
  if (cache.inFlight) return cache.inFlight;
  cache.inFlight = (async () => {
    try {
      const credential = readStoredCredential("anthropic");
      if (credential?.type !== "oauth" || credential.expires <= Date.now()) return cache.value;
      const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
        headers: {
          authorization: `Bearer ${credential.access}`,
          "anthropic-beta": "oauth-2025-04-20",
          "user-agent": "claude-cli/2.1.75",
          "x-app": "cli",
        },
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      });
      if (!response.ok) return cache.value;
      const limits = normalizeClaudeRateLimits(await response.json());
      if (limits) cache.value = limits;
      return cache.value;
    } catch {
      return cache.value;
    } finally {
      cache.attemptedAt = Date.now();
      cache.inFlight = undefined;
    }
  })();
  return cache.inFlight;
}

export async function GET() {
  try {
    const since = Date.now() - WINDOW_MS;
    const root = join(getAgentDir(), "sessions");
    const paths = (await readdir(root, { recursive: true })).filter((path) => path.endsWith(".jsonl"));
    const recent = await Promise.all(paths.map(async (path) => {
      const absolute = join(root, path);
      return (await stat(absolute)).mtimeMs >= since ? readFile(absolute, "utf8") : undefined;
    }));
    const usage = aggregateSprintPilotUsage(recent.filter((content): content is string => !!content), since);
    usage.claude.rateLimits = await claudeRateLimits();
    return Response.json({ windowDays: 7, usage });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const usage = aggregateSprintPilotUsage([], Date.now());
      usage.claude.rateLimits = await claudeRateLimits();
      return Response.json({ windowDays: 7, usage });
    }
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

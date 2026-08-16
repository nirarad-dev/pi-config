import { open, readdir, stat } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { latestCodexRateLimits, normalizeClaudeRateLimits, type ClaudeRateLimits, type ProviderRateLimits, type SprintPilotUsage } from "@/lib/sprintpilot-usage";

export const dynamic = "force-dynamic";

const PROVIDER_CACHE_MS = 60_000;
const CODEX_TAIL_BYTES = 512 * 1024;

type ClaudeUsageCache = { attemptedAt: number; value?: ClaudeRateLimits; inFlight?: Promise<ClaudeRateLimits | undefined> };
declare global { var __sprintPilotClaudeUsage: ClaudeUsageCache | undefined; }
type CodexUsageCache = { attemptedAt: number; value?: ProviderRateLimits; inFlight?: Promise<ProviderRateLimits | undefined> };
declare global { var __sprintPilotCodexUsage: CodexUsageCache | undefined; }

async function claudeRateLimits() {
  globalThis.__sprintPilotClaudeUsage ||= { attemptedAt: 0 };
  const cache = globalThis.__sprintPilotClaudeUsage;
  if (Date.now() - cache.attemptedAt < PROVIDER_CACHE_MS) return cache.value;
  if (cache.inFlight) return cache.inFlight;
  cache.inFlight = (async () => {
    try {
      const credential = readStoredCredential("anthropic");
      if (credential?.type !== "oauth" || credential.expires <= Date.now()) {
        cache.value = undefined;
        return undefined;
      }
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
      if (!response.ok) {
        cache.value = undefined;
        return undefined;
      }
      const limits = normalizeClaudeRateLimits(await response.json());
      if (limits) cache.value = limits;
      return limits;
    } catch {
      cache.value = undefined;
      return undefined;
    } finally {
      cache.attemptedAt = Date.now();
      cache.inFlight = undefined;
    }
  })();
  return cache.inFlight;
}

async function readTail(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const size = (await handle.stat()).size;
    const length = Math.min(size, CODEX_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    return size > length ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await handle.close();
  }
}

async function codexRateLimits() {
  globalThis.__sprintPilotCodexUsage ||= { attemptedAt: 0 };
  const cache = globalThis.__sprintPilotCodexUsage;
  if (Date.now() - cache.attemptedAt < PROVIDER_CACHE_MS) return cache.value;
  if (cache.inFlight) return cache.inFlight;
  cache.inFlight = (async () => {
    try {
  const roots = [join(homedir(), ".codex", "sessions"), join(homedir(), ".codex", "archived_sessions")];
  const candidates = (await Promise.all(roots.map(async (root) => {
    try {
      const paths = (await readdir(root, { recursive: true })).filter((path) => path.endsWith(".jsonl"));
      return Promise.all(paths.map(async (path) => {
        const absolute = join(root, path);
        return { absolute, modifiedAt: (await stat(absolute)).mtimeMs };
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }))).flat().sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 3);
      cache.value = latestCodexRateLimits(await Promise.all(candidates.map((candidate) => readTail(candidate.absolute))));
      return cache.value;
    } catch {
      cache.value = undefined;
      return undefined;
    } finally {
      cache.attemptedAt = Date.now();
      cache.inFlight = undefined;
    }
  })();
  return cache.inFlight;
}

export async function GET() {
  try {
    const usage: SprintPilotUsage = { claude: { tokens: 0, turns: 0 }, codex: { tokens: 0, turns: 0 } };
    [usage.claude.rateLimits, usage.codex.rateLimits] = await Promise.all([claudeRateLimits(), codexRateLimits()]);
    return Response.json({ usage });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

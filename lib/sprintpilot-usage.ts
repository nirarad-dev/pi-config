export type ProviderUsage = {
  tokens: number;
  turns: number;
  updatedAt?: string;
};

export type ProviderRateLimits = {
  fiveHour?: { usedPercentage: number; resetsAt?: string };
  weekly?: { usedPercentage: number; resetsAt?: string };
  fetchedAt: string;
};

export type ClaudeRateLimits = ProviderRateLimits;

export type SprintPilotUsage = {
  claude: ProviderUsage & { rateLimits?: ProviderRateLimits };
  codex: ProviderUsage & { rateLimits?: ProviderRateLimits };
};

function usageWindow(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const usedPercentage = Number(record.percent ?? record.utilization ?? record.used_percentage ?? record.used_percent);
  if (!Number.isFinite(usedPercentage)) return undefined;
  const rawReset = record.resets_at;
  const resetsAt = typeof rawReset === "string" ? rawReset
    : typeof rawReset === "number" && Number.isFinite(rawReset) ? new Date(rawReset * 1000).toISOString()
      : undefined;
  return { usedPercentage: Math.max(0, Math.min(100, usedPercentage)), ...(resetsAt ? { resetsAt } : {}) };
}

export function normalizeClaudeRateLimits(value: unknown, fetchedAt = new Date().toISOString()): ClaudeRateLimits | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const limits = Array.isArray(record.limits) ? record.limits.filter((limit): limit is Record<string, unknown> => !!limit && typeof limit === "object") : [];
  const activeSession = limits.find((limit) => limit.kind === "session" && limit.is_active === true)
    ?? limits.find((limit) => limit.kind === "session");
  const activeWeekly = limits.find((limit) => limit.kind === "weekly_all" && limit.is_active === true)
    ?? limits.find((limit) => limit.kind === "weekly_all");
  const fiveHour = usageWindow(activeSession ?? record.five_hour);
  const weekly = usageWindow(activeWeekly ?? record.seven_day);
  if (!fiveHour && !weekly) return undefined;
  return { ...(fiveHour ? { fiveHour } : {}), ...(weekly ? { weekly } : {}), fetchedAt };
}

function codexWindow(value: unknown): { minutes: number; window: { usedPercentage: number; resetsAt?: string } } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const minutes = Number(record.window_minutes);
  const window = usageWindow(record);
  return Number.isFinite(minutes) && window ? { minutes, window } : undefined;
}

export function normalizeCodexRateLimits(value: unknown, fetchedAt = new Date().toISOString()): ProviderRateLimits | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const windows = [codexWindow(record.primary), codexWindow(record.secondary)].filter((window): window is NonNullable<typeof window> => !!window);
  if (!windows.length) return undefined;
  const fiveHour = windows.find((window) => window.minutes <= 6 * 60)?.window;
  const weekly = windows.find((window) => window.minutes >= 6 * 24 * 60)?.window;
  return { ...(fiveHour ? { fiveHour } : {}), ...(weekly ? { weekly } : {}), fetchedAt };
}

export function latestCodexRateLimits(contents: readonly string[]): ProviderRateLimits | undefined {
  let latestTimestamp = 0;
  let latest: ProviderRateLimits | undefined;
  for (const content of contents) {
    for (const line of content.split("\n")) {
      if (!line.includes('"rate_limits"')) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const payload = entry.payload && typeof entry.payload === "object" ? entry.payload as Record<string, unknown> : undefined;
        const timestamp = Date.parse(String(entry.timestamp || ""));
        const limits = payload?.rate_limits;
        if (payload?.type !== "token_count" || !Number.isFinite(timestamp) || timestamp < latestTimestamp) continue;
        const normalized = normalizeCodexRateLimits(limits, new Date(timestamp).toISOString());
        if (normalized) {
          latestTimestamp = timestamp;
          latest = normalized;
        }
      } catch {
        continue;
      }
    }
  }
  return latest;
}

function providerBucket(provider: unknown): keyof SprintPilotUsage | undefined {
  const value = String(provider || "").toLowerCase();
  if (value.includes("anthropic") || value.includes("claude")) return "claude";
  if (value.includes("openai") || value.includes("codex")) return "codex";
}

function entryTime(entry: Record<string, unknown>): number {
  const message = entry.message && typeof entry.message === "object" ? entry.message as Record<string, unknown> : undefined;
  const timestamp = message?.timestamp ?? entry.timestamp;
  const parsed = typeof timestamp === "number" ? timestamp : Date.parse(String(timestamp || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function aggregateSprintPilotUsage(contents: readonly string[], since: number): SprintPilotUsage {
  const usage: SprintPilotUsage = { claude: { tokens: 0, turns: 0 }, codex: { tokens: 0, turns: 0 } };
  for (const content of contents) {
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.type !== "message" || entryTime(entry) < since) continue;
        const message = entry.message && typeof entry.message === "object" ? entry.message as Record<string, unknown> : undefined;
        if (message?.role !== "assistant") continue;
        const bucket = providerBucket(message.provider);
        const messageUsage = message.usage && typeof message.usage === "object" ? message.usage as Record<string, unknown> : undefined;
        if (!bucket || !messageUsage) continue;
        const tokens = Number(messageUsage.totalTokens);
        usage[bucket].tokens += Number.isFinite(tokens) ? tokens : 0;
        usage[bucket].turns += 1;
        const timestamp = entryTime(entry);
        const current = usage[bucket].updatedAt ? Date.parse(usage[bucket].updatedAt) : 0;
        if (timestamp > current) usage[bucket].updatedAt = new Date(timestamp).toISOString();
      } catch {
        continue;
      }
    }
  }
  return usage;
}

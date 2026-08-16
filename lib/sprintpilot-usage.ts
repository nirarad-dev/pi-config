export type ProviderUsage = {
  tokens: number;
  turns: number;
  updatedAt?: string;
};

export type ClaudeRateLimits = {
  fiveHour?: { usedPercentage: number; resetsAt?: string };
  weekly?: { usedPercentage: number; resetsAt?: string };
  fetchedAt: string;
};

export type SprintPilotUsage = {
  claude: ProviderUsage & { rateLimits?: ClaudeRateLimits };
  codex: ProviderUsage;
};

function usageWindow(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const usedPercentage = Number(record.utilization ?? record.used_percentage);
  if (!Number.isFinite(usedPercentage)) return undefined;
  const resetsAt = typeof record.resets_at === "string" ? record.resets_at : undefined;
  return { usedPercentage: Math.max(0, Math.min(100, usedPercentage)), ...(resetsAt ? { resetsAt } : {}) };
}

export function normalizeClaudeRateLimits(value: unknown, fetchedAt = new Date().toISOString()): ClaudeRateLimits | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const fiveHour = usageWindow(record.five_hour);
  const weekly = usageWindow(record.seven_day);
  if (!fiveHour && !weekly) return undefined;
  return { ...(fiveHour ? { fiveHour } : {}), ...(weekly ? { weekly } : {}), fetchedAt };
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

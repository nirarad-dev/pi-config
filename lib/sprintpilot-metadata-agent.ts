import { Agent, type AgentOptions, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { buildSessionTitleAgentOptions } from "./session-title";

/**
 * Model ids known to be fast and cheap enough for metadata drafting, ranked
 * best-first. Matched as a prefix so dated ids (claude-haiku-4-5-20251001)
 * still resolve. The generic pattern below catches vendors not listed here.
 */
const PREFERRED_FAST_MODEL_IDS = [
  "claude-haiku",
  "gpt-5-mini",
  "gpt-5-nano",
  "gemini-2.5-flash",
  "gemini-flash",
  "grok-code",
];
const FAST_MODEL_PATTERN = /(?:haiku|mini|flash|small|nano|spark|lite|turbo)/i;

type SnapshotModelRuntime = {
  getAvailableSnapshot?: () => readonly { id: string; provider: string }[];
};

export type SprintPilotMetadataModel = { provider: string; id: string; fast: boolean };

/**
 * Pick the cheapest model the session can already reach. Selection stays inside
 * the active provider on purpose: another provider may be configured but not
 * authorized, and a metadata draft must never be the thing that trips an auth
 * prompt. `fast` reports whether a genuinely lightweight model was found, so
 * callers can tell the user when drafting ran on the full coding model.
 */
export function selectSprintPilotMetadataModel(source: AgentSession): SprintPilotMetadataModel | undefined {
  const active = source.model;
  if (!active) return undefined;
  const available = (source.modelRuntime as unknown as SnapshotModelRuntime).getAvailableSnapshot?.() || [];
  const sameProvider = available.filter((model) => model.provider === active.provider);
  for (const preferred of PREFERRED_FAST_MODEL_IDS) {
    const match = sameProvider.find((model) => model.id.toLowerCase().startsWith(preferred));
    if (match) return { provider: match.provider, id: match.id, fast: true };
  }
  const patternMatch = sameProvider.find((model) => FAST_MODEL_PATTERN.test(model.id));
  if (patternMatch) return { provider: patternMatch.provider, id: patternMatch.id, fast: true };
  return { provider: active.provider, id: active.id, fast: false };
}

/**
 * Build a throwaway Agent that shares the session's provider transport and
 * credentials but nothing else.
 *
 * The session-title helper copies the source agent's system prompt, tool
 * schemas, and transcript, because a title is a summary of that conversation.
 * Metadata drafting is the opposite: the ticket, the diff, and the repository's
 * own commit history are the entire input. Sending the coding-agent system
 * prompt and every tool definition ahead of them costs tens of thousands of
 * prefix tokens per draft and biases the model toward tool use, which is the
 * main reason drafting felt slow.
 */
export function buildSprintPilotMetadataAgentOptions(source: AgentSession, systemPrompt: string): AgentOptions {
  const options = buildSessionTitleAgentOptions(source.agent);
  const initialState = options.initialState!;
  initialState.systemPrompt = systemPrompt;
  initialState.messages = [];
  initialState.tools = [];
  initialState.thinkingLevel = "off" as ThinkingLevel;
  const model = selectSprintPilotMetadataModel(source);
  if (model) {
    const selected = (source.modelRuntime as unknown as SnapshotModelRuntime)
      .getAvailableSnapshot?.()
      .find((candidate) => candidate.provider === model.provider && candidate.id === model.id);
    if (selected) initialState.model = selected as typeof initialState.model;
  }
  return options;
}

function latestAssistantText(agent: Agent): string {
  for (const message of [...agent.state.messages].reverse()) {
    if (message.role !== "assistant") continue;
    if (message.stopReason === "error") throw new Error(message.errorMessage || "Metadata generation failed");
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  throw new Error("The model did not return any metadata");
}

export type SprintPilotMetadataRun = { text: string; model?: SprintPilotMetadataModel };

/** Run one stateless metadata prompt against the session's provider. */
export async function runSprintPilotMetadataAgent(source: AgentSession, input: {
  systemPrompt: string;
  prompt: string;
  timeoutMs: number;
}): Promise<SprintPilotMetadataRun> {
  await source.agent.waitForIdle();
  const model = selectSprintPilotMetadataModel(source);
  const agent = new Agent(buildSprintPilotMetadataAgentOptions(source, input.systemPrompt));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const runPromise = agent.prompt(input.prompt);
  try {
    await Promise.race([runPromise, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        agent.abort();
        reject(new Error(`Metadata generation timed out after ${Math.round(input.timeoutMs / 1000)}s`));
      }, input.timeoutMs);
    })]);
  } catch (error) {
    agent.abort();
    await runPromise.catch(() => {});
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  return { text: latestAssistantText(agent), model };
}

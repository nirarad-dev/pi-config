import { open, stat } from "fs/promises";

/**
 * Whether a task agent is waiting on the operator, read from the session file.
 *
 * The live monitor state cannot answer this. `lastPromptFinishedAt` lives on the
 * in-memory AgentSessionWrapper, so it is undefined for any session resumed
 * after a server restart, and it disappears entirely when the wrapper hits its
 * ten-minute idle timeout. The rail's alert additionally required the browser to
 * have personally observed the running-to-stopped transition, which a reload or
 * a background tab misses. The result was an alert that only ever appeared if
 * you were already looking at the screen.
 *
 * The session file is durable and says the same thing more directly: if the last
 * message is the assistant's, the agent spoke last and the operator has not
 * replied.
 */

const TAIL_BYTES = 64 * 1024;

/** Role of the last user or assistant message in a session transcript. */
export function lastSpeakerFromTail(tail: string): "user" | "assistant" | undefined {
  const lines = tail.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    if (!line.startsWith("{")) continue;
    let entry: { type?: unknown; message?: { role?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      // The first line of a mid-file tail is usually truncated. Skip it.
      continue;
    }
    if (entry.type !== "message") continue;
    const role = entry.message?.role;
    // Tool results sit between the assistant's turns; they say nothing about
    // whose turn it is, so keep walking back to the last real speaker.
    if (role === "user" || role === "assistant") return role;
  }
  return undefined;
}

/**
 * Read only the tail of the transcript. Task sessions are polled every couple of
 * seconds and can grow to megabytes, so parsing the whole file per tick would
 * make the rail cost more than the work it reports on.
 */
export async function isAwaitingReply(sessionFile: string): Promise<boolean> {
  try {
    const { size } = await stat(sessionFile);
    const start = Math.max(0, size - TAIL_BYTES);
    const handle = await open(sessionFile, "r");
    try {
      const { buffer, bytesRead } = await handle.read({
        buffer: Buffer.alloc(Math.min(TAIL_BYTES, size)),
        position: start,
      });
      return lastSpeakerFromTail(buffer.subarray(0, bytesRead).toString("utf8")) === "assistant";
    } finally {
      await handle.close();
    }
  } catch {
    // A deleted or unreadable session simply has nothing pending.
    return false;
  }
}

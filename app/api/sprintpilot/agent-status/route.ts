import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { isAwaitingReply } from "@/lib/sprintpilot-awaiting-reply";
import { resolveSessionPath } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

const MAX_SESSIONS = 50;

export async function GET(request: Request) {
  const rawIds = new URL(request.url).searchParams.get("ids") || "";
  const ids = [...new Set(rawIds.split(",").map((id) => id.trim()).filter(Boolean))];
  if (ids.length > MAX_SESSIONS || ids.some((id) => id.length > 200)) {
    return NextResponse.json({ error: "Invalid session list" }, { status: 400 });
  }

  const entries = await Promise.all(ids.map(async (id) => {
    const session = getRpcSession(id);
    const live = session?.isAlive()
      ? session.getMonitorState()
      : { running: false, queued: false, needsUserInput: false };
    // Read from the transcript rather than the wrapper: the wrapper's
    // lastPromptFinishedAt is undefined for a resumed session and gone once the
    // idle timeout destroys it, which is why a finished agent could show no
    // signal at all. A running agent is working, not waiting.
    const sessionPath = live.running ? null : await resolveSessionPath(id);
    const awaitingReply = sessionPath ? await isAwaitingReply(sessionPath) : false;
    return [id, { ...live, awaitingReply }] as const;
  }));

  return NextResponse.json({ statuses: Object.fromEntries(entries) });
}

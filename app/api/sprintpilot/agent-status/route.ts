import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";

const MAX_SESSIONS = 50;

export async function GET(request: Request) {
  const rawIds = new URL(request.url).searchParams.get("ids") || "";
  const ids = [...new Set(rawIds.split(",").map((id) => id.trim()).filter(Boolean))];
  if (ids.length > MAX_SESSIONS || ids.some((id) => id.length > 200)) {
    return NextResponse.json({ error: "Invalid session list" }, { status: 400 });
  }

  const statuses = Object.fromEntries(ids.map((id) => {
    const session = getRpcSession(id);
    return [id, session?.isAlive()
      ? session.getMonitorState()
      : { running: false, queued: false, needsUserInput: false }];
  }));
  return NextResponse.json({ statuses });
}

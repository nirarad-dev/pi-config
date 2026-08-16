import { NextResponse } from "next/server";
import {
  attachSessionProjectInfo,
  listAllSessions,
  listSessionsForCwd,
  mergeSessionLists,
} from "@/lib/session-reader";
import { getRpcSessionInfos, getRunningRpcSessionIds } from "@/lib/rpc-manager";
import { samePath } from "@/lib/paths";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const searchParams = new URL(req.url).searchParams;
    const force = searchParams.get("force") === "1";
    const cwd = searchParams.get("cwd")?.trim();
    const runtimeInfos = getRpcSessionInfos();
    const [persistedSessions, runtimeSessions] = await Promise.all([
      cwd ? listSessionsForCwd(cwd) : listAllSessions({ force }),
      attachSessionProjectInfo(cwd ? runtimeInfos.filter((session) => samePath(session.cwd, cwd)) : runtimeInfos),
    ]);
    const sessions = mergeSessionLists(persistedSessions, runtimeSessions);
    return NextResponse.json(
      { sessions, runningSessionIds: getRunningRpcSessionIds() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

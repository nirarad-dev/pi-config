import { existsSync, readdirSync } from "fs";
import { join, relative, resolve } from "path";
import { NextRequest, NextResponse } from "next/server";
import { resolveTestArgs, TEST_PRESETS } from "@/lib/sprintpilot-config";
import { assertSprintWorktree, run } from "@/lib/sprintpilot-server";

export async function GET(request: NextRequest) {
  try {
    const cwd = await assertSprintWorktree(request.nextUrl.searchParams.get("cwd"));
    const root = resolve(cwd, "automation/tests");
    const files: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.name === "__pycache__") continue;
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) walk(absolute);
        else if (entry.isFile() && entry.name.endsWith(".py")) files.push(relative(cwd, absolute));
      }
    };
    walk(root);
    return NextResponse.json({ files: files.sort() });
  } catch (error) {
    return NextResponse.json({ files: [], error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { cwd?: string; file?: string; preset?: string; options?: string[] };
    const cwd = await assertSprintWorktree(body.cwd);
    const testsRoot = resolve(cwd, "automation/tests");
    const testFile = resolve(cwd, String(body.file || ""));
    const rel = relative(testsRoot, testFile);
    if (!rel || rel.startsWith("..") || !testFile.endsWith(".py") || !existsSync(testFile)) {
      throw new Error("Choose an existing Python file under automation/tests");
    }
    const preset = TEST_PRESETS.find((candidate) => candidate.id === body.preset);
    if (!preset) throw new Error("Unknown launch configuration");
    const optionIds = Array.isArray(body.options) ? body.options.map(String) : [];
    const testArgs = resolveTestArgs(preset, optionIds);
    const python = resolve(cwd, "automation/.venv/bin/python");
    if (!existsSync(python)) throw new Error(`Automation virtualenv not found: ${python}`);
    const output = await run(python, ["-m", "pytest", testFile, ...testArgs], resolve(cwd, "automation"), preset.env);
    return NextResponse.json({ success: true, output, command: ["python", "-m", "pytest", `tests/${rel}`, ...testArgs] });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

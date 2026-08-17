const MAX_SUBJECT_LENGTH = 100;

export type SprintPilotCommitOrigin = "agent" | "repaired" | "fallback";

/**
 * Keep a usable draft instead of discarding the model's work.
 *
 * The previous parser required the ticket key, a length limit, and Markdown
 * bullets all at once, and returned the deterministic file-list fallback when
 * any single check failed. In practice the model routinely produced a good
 * message that merely omitted the "DEV-1234: " prefix, so the user saw a bare
 * list of changed files and assumed that was the model's best effort. Repair
 * what is mechanically repairable and fall back only on genuinely unusable
 * output.
 *
 * Lives here, beside the deterministic builder, so it stays free of SDK
 * imports and can be unit-tested directly.
 */
export function parseSprintPilotCommitMessage(raw: string, fallback: string, taskKey?: string): { message: string; generatedBy: SprintPilotCommitOrigin } {
  const value = raw.trim().replace(/^```(?:text|markdown|git)?\s*/i, "").replace(/\s*```$/, "").trim();
  const lines = value.split(/\r?\n/);
  let subject = lines.shift()?.replace(/^commit message\s*:\s*/i, "").trim() || "";
  const body = lines.join("\n").trim();
  if (!subject || !body || !/^[-*] /m.test(body)) return { message: fallback, generatedBy: "fallback" };

  let repaired = false;
  if (taskKey && !new RegExp(`\\b${taskKey}\\b`).test(subject)) {
    subject = `${taskKey}: ${subject}`;
    repaired = true;
  }
  if (subject.length > MAX_SUBJECT_LENGTH) {
    subject = `${subject.slice(0, MAX_SUBJECT_LENGTH - 1).trimEnd()}…`;
    repaired = true;
  }
  return {
    message: `${subject}\n\n${body}`.replace(/\n{3,}/g, "\n\n"),
    generatedBy: repaired ? "repaired" : "agent",
  };
}

function changedSymbols(patch: string): string[] {
  const symbols = new Set<string>();
  const patterns = [
    /\b(?:class|interface|enum|type)\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:async\s+)?(?:def|function|func)\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/g,
  ];
  const changed = patch.split("\n").filter((line) => /^[+-](?![+-])/.test(line)).join("\n");
  for (const pattern of patterns) {
    for (const match of changed.matchAll(pattern)) symbols.add(match[1]);
  }
  return [...symbols].slice(0, 4);
}

function patchForFile(patch: string, file: string): string {
  return patch.split(/(?=^diff --git )/m).find((section) => section.includes(` b/${file}`)) || "";
}

export function buildSprintPilotCommitMessage(title: string, files: string[], patch: string): string {
  const subject = title.trim().split("\n")[0].slice(0, 72) || "Update approved changes";
  const bullets = files.slice(0, 8).map((file) => {
    const section = patchForFile(patch, file);
    const isTest = /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\./i.test(file);
    const verb = /deleted file mode/.test(section) ? "Remove"
      : isTest ? "Cover"
        : /new file mode/.test(section) || !section ? "Add" : "Update";
    const symbols = changedSymbols(section);
    return `- ${verb} ${file}${symbols.length ? ` around ${symbols.join(", ")}` : ""}`;
  });
  if (files.length > bullets.length) bullets.push(`- Update ${files.length - bullets.length} additional approved files`);
  return `${subject}\n\n${bullets.join("\n")}`;
}

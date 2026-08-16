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

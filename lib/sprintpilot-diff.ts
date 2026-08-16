export type DiffLine = { kind: "context" | "added" | "removed"; content: string; oldLine?: number; newLine?: number };
export type DiffHunk = { label: string; lines: DiffLine[] };

export function parseDiff(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  for (const line of patch.split("\n")) {
    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      current = { label: header[3].trim() || `Lines ${oldLine}–${newLine}`, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current || line.startsWith("\\ No newline")) continue;
    if (line.startsWith("+")) {
      current.lines.push({ kind: "added", content: line.slice(1), newLine: newLine++ });
    } else if (line.startsWith("-")) {
      current.lines.push({ kind: "removed", content: line.slice(1), oldLine: oldLine++ });
    } else if (line.startsWith(" ")) {
      current.lines.push({ kind: "context", content: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
    }
  }
  return hunks;
}

import type { DiffLine } from "./sprintpilot-diff";

/**
 * Word-level detail for the diff viewer.
 *
 * A line-level background alone says "something on this line changed" and
 * nothing more, so a reformatted line and a rewritten one look identical.
 *
 * The comparison runs across a whole replacement — every removed line against
 * every added line — rather than pairing them positionally. Positional pairing
 * cannot see a reflow: when one line is split into three, it compares the
 * original against the first fragment and calls the rest brand new, burying the
 * one argument that genuinely changed under a wall of colour. Diffing the runs
 * as one token stream makes a moved line break just another token, so what
 * survives as "changed" is the code that actually changed.
 */

export type DiffSegment = { text: string; changed: boolean };

export type AnnotatedDiffLine = DiffLine & {
  segments: DiffSegment[];
  /**
   * The line's only differences are whitespace or a moved line break — a
   * reindent, a rewrap, a reformat. No code was added or removed on it.
   */
  formattingOnly: boolean;
};

/** Stands in for a line break inside a run's token stream. */
const NEWLINE = "\n";

/** Beyond this the quadratic table is not worth building; see annotateDiffLines. */
const MAX_LCS_CELLS = 400_000;

/**
 * Split into words, punctuation, and whitespace runs, keeping every character.
 * Whitespace is tokenized rather than skipped so an indentation change is a
 * difference the comparison can see.
 */
export function tokenizeDiffLine(text: string): string[] {
  return text.match(/[^\S\n]+|[A-Za-z0-9_$]+|[^\s A-Za-z0-9_$]/g) || [];
}

function tokenizeRun(lines: string[]): string[] {
  return lines.flatMap((line, index) => index === 0 ? tokenizeDiffLine(line) : [NEWLINE, ...tokenizeDiffLine(line)]);
}

function isInvisible(token: string): boolean {
  return token === NEWLINE || /^\s+$/.test(token);
}

type Op = { token: string; side: "common" | "removed" | "added" };

/**
 * Longest common subsequence over tokens, returned as an edit script.
 *
 * Prefix and suffix are trimmed first: a replacement usually shares long
 * unchanged head and tail regions, and removing them keeps the table small
 * enough that the quadratic step only ever runs over the part that differs.
 */
export function diffTokens(before: string[], after: string[]): Op[] {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix++;

  const head = before.slice(0, prefix).map((token): Op => ({ token, side: "common" }));
  const tail = before.slice(before.length - suffix).map((token): Op => ({ token, side: "common" }));
  const midBefore = before.slice(prefix, before.length - suffix);
  const midAfter = after.slice(prefix, after.length - suffix);

  if (!midBefore.length && !midAfter.length) return [...head, ...tail];
  if (!midBefore.length) return [...head, ...midAfter.map((token): Op => ({ token, side: "added" })), ...tail];
  if (!midAfter.length) return [...head, ...midBefore.map((token): Op => ({ token, side: "removed" })), ...tail];

  if (midBefore.length * midAfter.length > MAX_LCS_CELLS) {
    return [
      ...head,
      ...midBefore.map((token): Op => ({ token, side: "removed" })),
      ...midAfter.map((token): Op => ({ token, side: "added" })),
      ...tail,
    ];
  }

  const rows = midBefore.length;
  const columns = midAfter.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(columns + 1).fill(0));
  for (let row = rows - 1; row >= 0; row--) {
    for (let column = columns - 1; column >= 0; column--) {
      table[row][column] = midBefore[row] === midAfter[column]
        ? table[row + 1][column + 1] + 1
        : Math.max(table[row + 1][column], table[row][column + 1]);
    }
  }

  const middle: Op[] = [];
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (midBefore[row] === midAfter[column]) {
      middle.push({ token: midBefore[row], side: "common" });
      row++;
      column++;
    } else if (table[row + 1][column] >= table[row][column + 1]) {
      middle.push({ token: midBefore[row++], side: "removed" });
    } else {
      middle.push({ token: midAfter[column++], side: "added" });
    }
  }
  while (row < rows) middle.push({ token: midBefore[row++], side: "removed" });
  while (column < columns) middle.push({ token: midAfter[column++], side: "added" });

  return [...head, ...middle, ...tail];
}

/**
 * Rebuild one side of a run into per-line segments.
 *
 * Filtering the edit script to the ops that side actually contains reproduces
 * its original text exactly, so splitting on the newline tokens gives the
 * original lines back. A changed newline is the reflow itself: it delimits but
 * never renders, since a highlight on an invisible character would just be a
 * stray block of colour at the end of a line.
 */
function rebuildSide(ops: Op[], side: "removed" | "added"): { segments: DiffSegment[]; formattingOnly: boolean }[] {
  const lines: { segments: DiffSegment[]; formattingOnly: boolean }[] = [];
  let segments: DiffSegment[] = [];
  let realChange = false;
  let anyChange = false;

  const pushSegment = (text: string, changed: boolean) => {
    const last = segments[segments.length - 1];
    if (last && last.changed === changed) last.text += text;
    else segments.push({ text, changed });
  };
  const endLine = () => {
    lines.push({ segments, formattingOnly: anyChange && !realChange });
    segments = [];
    realChange = false;
    anyChange = false;
  };

  for (const op of ops) {
    if (op.side !== "common" && op.side !== side) continue;
    const changed = op.side !== "common";
    if (op.token === NEWLINE) {
      if (changed) anyChange = true;
      endLine();
      continue;
    }
    pushSegment(op.token, changed);
    if (changed) {
      anyChange = true;
      if (!isInvisible(op.token)) realChange = true;
    }
  }
  endLine();
  return lines;
}

function wholeLine(line: DiffLine): AnnotatedDiffLine {
  return {
    ...line,
    segments: line.content ? [{ text: line.content, changed: line.kind !== "context" }] : [],
    formattingOnly: false,
  };
}

/**
 * Annotate a hunk's lines.
 *
 * Git emits a replacement as a run of removed lines followed by a run of added
 * lines. Those two runs are compared as a whole, which is what lets a line
 * break move without being mistaken for a code change.
 */
export function annotateDiffLines(lines: DiffLine[]): AnnotatedDiffLine[] {
  const annotated: AnnotatedDiffLine[] = [];
  let index = 0;

  while (index < lines.length) {
    if (lines[index].kind !== "removed") {
      annotated.push(wholeLine(lines[index]));
      index++;
      continue;
    }

    const removed: DiffLine[] = [];
    while (index < lines.length && lines[index].kind === "removed") removed.push(lines[index++]);
    const added: DiffLine[] = [];
    while (index < lines.length && lines[index].kind === "added") added.push(lines[index++]);

    if (!added.length) {
      annotated.push(...removed.map(wholeLine));
      continue;
    }

    const ops = diffTokens(tokenizeRun(removed.map((line) => line.content)), tokenizeRun(added.map((line) => line.content)));
    const removedDetail = rebuildSide(ops, "removed");
    const addedDetail = rebuildSide(ops, "added");
    // Formatting is a property of the replacement, not of one side. A rewrap
    // often leaves one side with no changed tokens at all — the text it holds
    // survived verbatim — and that side must still read as formatting rather
    // than as an ordinary edit, or half a reflow would light up.
    const runIsFormatting = !ops.some((op) => op.side !== "common" && !isInvisible(op.token));
    const merge = (line: DiffLine, detail: { segments: DiffSegment[]; formattingOnly: boolean } | undefined) => ({
      ...line,
      ...(detail || wholeLine(line)),
      formattingOnly: runIsFormatting || (detail?.formattingOnly ?? false),
    });
    annotated.push(
      ...removed.map((line, position) => merge(line, removedDetail[position])),
      ...added.map((line, position) => merge(line, addedDetail[position])),
    );
  }

  return annotated;
}

/** Whether every changed line in a hunk is formatting only, for the hunk label. */
export function isFormattingOnlyHunk(lines: AnnotatedDiffLine[]): boolean {
  const changed = lines.filter((line) => line.kind !== "context");
  return changed.length > 0 && changed.every((line) => line.formattingOnly);
}

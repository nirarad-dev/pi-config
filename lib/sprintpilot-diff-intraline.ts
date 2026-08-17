import type { DiffLine } from "./sprintpilot-diff";

/**
 * Word-level detail for the diff viewer.
 *
 * A line-level background alone says "something on this line changed" and
 * nothing more, so a reformatted line and a rewritten one look identical. This
 * pairs each removed line with the added line that replaced it, marks the words
 * that actually differ, and flags the pairs whose only difference is
 * whitespace — which is what lets the viewer render reformatting quietly and
 * real edits loudly.
 */

export type DiffSegment = { text: string; changed: boolean };

export type AnnotatedDiffLine = DiffLine & {
  segments: DiffSegment[];
  /** The paired lines are identical once whitespace is ignored. */
  whitespaceOnly: boolean;
};

/**
 * Split into words, punctuation, and whitespace runs, keeping every character.
 * Whitespace is tokenized rather than skipped so an indentation change is a
 * difference the comparison can see.
 */
export function tokenizeDiffLine(text: string): string[] {
  return text.match(/\s+|[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$]/g) || [];
}

function joinTokens(tokens: string[]): string {
  return tokens.join("");
}

/**
 * Mark the differing middle of two token lists.
 *
 * Trimming the common prefix and suffix is what diff viewers use for
 * intra-line detail: it is linear, stable, and for the edits people actually
 * make to one line it selects the same span a full LCS would, without the
 * scattered single-character highlights an LCS produces on dissimilar lines.
 */
export function segmentPair(before: string, after: string): { before: DiffSegment[]; after: DiffSegment[] } {
  const beforeTokens = tokenizeDiffLine(before);
  const afterTokens = tokenizeDiffLine(after);

  let prefix = 0;
  while (prefix < beforeTokens.length && prefix < afterTokens.length && beforeTokens[prefix] === afterTokens[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < beforeTokens.length - prefix
    && suffix < afterTokens.length - prefix
    && beforeTokens[beforeTokens.length - 1 - suffix] === afterTokens[afterTokens.length - 1 - suffix]
  ) {
    suffix++;
  }

  const build = (tokens: string[]): DiffSegment[] => {
    const head = joinTokens(tokens.slice(0, prefix));
    const middle = joinTokens(tokens.slice(prefix, tokens.length - suffix));
    const tail = joinTokens(tokens.slice(tokens.length - suffix));
    return [
      ...(head ? [{ text: head, changed: false }] : []),
      ...(middle ? [{ text: middle, changed: true }] : []),
      ...(tail ? [{ text: tail, changed: false }] : []),
    ];
  };
  return { before: build(beforeTokens), after: build(afterTokens) };
}

/** True when two lines differ only in whitespace — indentation, tabs, trailing space. */
export function isWhitespaceOnlyChange(before: string, after: string): boolean {
  if (before === after) return false;
  return before.replace(/\s+/g, "") === after.replace(/\s+/g, "");
}

function wholeLine(line: DiffLine): AnnotatedDiffLine {
  return {
    ...line,
    segments: line.content ? [{ text: line.content, changed: line.kind !== "context" }] : [],
    whitespaceOnly: false,
  };
}

/**
 * Annotate a hunk's lines.
 *
 * Git emits a replacement as a run of removed lines followed by a run of added
 * lines, so the nth removal pairs with the nth addition. Lines beyond the
 * shorter run are a genuine insertion or deletion and stay fully marked.
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

    const paired = Math.min(removed.length, added.length);
    const removedOut: AnnotatedDiffLine[] = [];
    const addedOut: AnnotatedDiffLine[] = [];
    for (let position = 0; position < paired; position++) {
      const before = removed[position].content;
      const after = added[position].content;
      const segments = segmentPair(before, after);
      const whitespaceOnly = isWhitespaceOnlyChange(before, after);
      removedOut.push({ ...removed[position], segments: segments.before, whitespaceOnly });
      addedOut.push({ ...added[position], segments: segments.after, whitespaceOnly });
    }
    for (let position = paired; position < removed.length; position++) removedOut.push(wholeLine(removed[position]));
    for (let position = paired; position < added.length; position++) addedOut.push(wholeLine(added[position]));
    annotated.push(...removedOut, ...addedOut);
  }

  return annotated;
}

/** Whether every changed line in a hunk is whitespace-only, for the hunk label. */
export function isWhitespaceOnlyHunk(lines: AnnotatedDiffLine[]): boolean {
  const changed = lines.filter((line) => line.kind !== "context");
  return changed.length > 0 && changed.every((line) => line.whitespaceOnly);
}

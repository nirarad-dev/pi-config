export type ReviewComment = {
  id: string;
  filePath: string;
  line: number;
  side: "old" | "new";
  kind: "context" | "added" | "removed";
  code: string;
  body: string;
  sentAt?: string;
};

function codeFence(value: string): string {
  return value.replace(/`/g, "\\`");
}

export function buildReviewFixPrompt(taskKey: string, comments: ReviewComment[]): string {
  const pending = comments.filter((comment) => !comment.sentAt);
  if (!pending.length) return "";

  const references = pending.map((comment, index) => {
    const side = comment.side === "old" ? "old line" : "line";
    return [
      `${index + 1}. ${comment.filePath}:${side} ${comment.line} (${comment.kind})`,
      `   Review comment: ${comment.body.trim()}`,
      `   Referenced code: \`${codeFence(comment.code.trim() || "(blank line)")}\``,
    ].join("\n");
  }).join("\n\n");

  return [
    `Fix the following code review comments for ${taskKey}.`,
    "Treat each file and line as a precise reference to the current pending changes. Inspect the surrounding code before editing, implement every valid fix, and run focused checks. Do not stage, commit, push, or open a PR.",
    "",
    references,
  ].join("\n");
}

/**
 * Issue-key handling for the surfaces GitHub for Jira scrapes.
 *
 * The integration reads plain text, not Markdown. Two consequences drive
 * everything here, both observed on a PR that looked correct and still never
 * appeared in Jira's Development panel:
 *
 *   - A key that exists only as a Markdown link target is not reliably seen.
 *     The Tickets section must carry the key as a bare token; a link may be
 *     added beside it, never substituted for it.
 *   - Any `LETTER-NUMBER` token is a candidate key. A branch or title carrying
 *     `latest-release-1` offers `RELEASE-1` alongside the real ticket, and the
 *     association can land on the wrong one or not at all.
 */

/**
 * GitHub for Jira matches issue keys case-insensitively, so a lint that only
 * looked for uppercase would pass a branch the integration still misreads.
 */
const ISSUE_KEY = /\b([A-Za-z][A-Za-z0-9]*)-(\d+)\b/g;

/** Every `LETTER-NUMBER` token in the text, normalized to upper case. */
export function extractJiraKeys(text: string): string[] {
  return [...text.matchAll(ISSUE_KEY)].map((match) => `${match[1].toUpperCase()}-${match[2]}`);
}

/**
 * Keys the integration would find beyond the ones this PR is really for.
 *
 * Returned in encounter order, deduplicated, so the error can name each once.
 */
export function findStrayJiraKeys(text: string, allowed: readonly string[]): string[] {
  const permitted = new Set(allowed.map((key) => key.toUpperCase()));
  return [...new Set(extractJiraKeys(text))].filter((key) => !permitted.has(key));
}

/**
 * Remove the constructs whose contents the scraper cannot be trusted to read:
 * Markdown link labels and targets, bare URLs, and reference-style definitions.
 * What remains is the text a bare key has to be found in.
 */
function withoutLinkedText(text: string): string {
  return text
    .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, " ")
    .replace(/\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/<[^>\s]+>/g, " ")
    .replace(/\bhttps?:\/\/\S+/g, " ");
}

/** Whether the key appears as its own token, outside any link or URL. */
export function hasBareJiraKey(text: string, key: string): boolean {
  return new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(withoutLinkedText(text));
}

/**
 * A reference-style footer of the kind GitHub for Jira injects after ingest.
 *
 * Copying one into the body a PR is created with does not attach anything; it
 * only imitates the appearance of a PR the integration has already processed,
 * which is what made the failure hard to spot.
 */
export function findInjectedJiraFooters(text: string): string[] {
  return [...text.matchAll(/^\s*\[[A-Za-z][A-Za-z0-9]*-\d+\]:\s*(\S*atlOrigin=\S*)\s*$/gm)].map((match) => match[1]);
}

/**
 * The Tickets section's body, or undefined when there is no such heading.
 * Both spellings are recognized: the repository templates disagree, and the
 * one already in the body is the one to write into.
 */
export function ticketsSection(description: string): string | undefined {
  // No `m` flag: under it `$` matches every line end, so the lazy body would
  // stop at the first newline and a section whose key sits on its second line
  // would read as if the key were absent. The start is anchored explicitly
  // instead, and `$` keeps its end-of-input meaning.
  return description.match(/(?:^|\n)## Ticket\(?s\)?[^\n]*\n([\s\S]*?)(?=\n## |$)/i)?.[1];
}

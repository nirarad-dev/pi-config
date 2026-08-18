import assert from "node:assert/strict";
import test from "node:test";
import {
  extractJiraKeys,
  findInjectedJiraFooters,
  findStrayJiraKeys,
  hasBareJiraKey,
  ticketsSection,
} from "./sprintpilot-jira-keys.ts";

test("every LETTER-NUMBER token is a candidate key, whatever its case", () => {
  assert.deepEqual(extractJiraKeys("[Automation] [DEV-26018] fix"), ["DEV-26018"]);
  assert.deepEqual(extractJiraKeys("nir/dev-26018-thing"), ["DEV-26018"]);
});

test("a version-like slug is caught as a stray key", () => {
  // The false positive from the investigation: `latest-release-1` offers
  // RELEASE-1 to the scraper beside the real ticket.
  assert.deepEqual(findStrayJiraKeys("[Automation] [DEV-26018] support latest-release-1", ["DEV-26018"]), ["RELEASE-1"]);
  assert.deepEqual(findStrayJiraKeys("nir/DEV-26018-api-2-vnext-3", ["DEV-26018"]), ["API-2", "VNEXT-3"]);
});

test("the real ticket is never a stray, in either case", () => {
  assert.deepEqual(findStrayJiraKeys("[Automation] [DEV-26018] clean title", ["DEV-26018"]), []);
  assert.deepEqual(findStrayJiraKeys("nir/dev-26018-clean", ["DEV-26018"]), []);
});

test("a key that exists only as a Markdown link is not bare", () => {
  // The exact shape that drifted: the scraper reads text, not Markdown.
  assert.equal(hasBareJiraKey("- [DEV-26018](https://x/browse/DEV-26018)", "DEV-26018"), false);
  assert.equal(hasBareJiraKey("<https://x/browse/DEV-26018>", "DEV-26018"), false);
  assert.equal(hasBareJiraKey("[DEV-26018]: https://x/browse/DEV-26018?atlOrigin=abc", "DEV-26018"), false);
});

test("a bare key is found, with or without a link beside it", () => {
  assert.equal(hasBareJiraKey("DEV-26018", "DEV-26018"), true);
  assert.equal(hasBareJiraKey("DEV-26018\nhttps://x/browse/DEV-26018", "DEV-26018"), true);
  assert.equal(hasBareJiraKey("- DEV-26018 ([browse](https://x/browse/DEV-26018))", "DEV-26018"), true);
});

test("an injected reference footer is recognized so it is never authored", () => {
  assert.deepEqual(
    findInjectedJiraFooters("body\n\n[DEV-26018]: https://fordefi.atlassian.net/browse/DEV-26018?atlOrigin=eyJp"),
    ["https://fordefi.atlassian.net/browse/DEV-26018?atlOrigin=eyJp"],
  );
  assert.deepEqual(findInjectedJiraFooters("[DEV-26018]: https://x/browse/DEV-26018"), []);
});

test("both Tickets spellings are recognized, so the body's own heading is used", () => {
  assert.match(ticketsSection("## Tickets\n\nDEV-1\n\n## Validation\n"), /DEV-1/);
  assert.match(ticketsSection("## Ticket(s)\n\nDEV-2\n"), /DEV-2/);
  assert.equal(ticketsSection("## Description\n\nnothing here\n"), undefined);
});

test("a Tickets section is read whole, not just its first line", () => {
  // Under the `m` flag `$` matches every line end, which truncated the section
  // and would refuse a body whose key sits below the link a human put first.
  const body = "## Tickets\n\nhttps://x/browse/DEV-1\nDEV-1\n\n## Validation\n\n- none\n";
  const section = ticketsSection(body);
  assert.match(section, /DEV-1$/m);
  assert.equal(hasBareJiraKey(section, "DEV-1"), true);
});

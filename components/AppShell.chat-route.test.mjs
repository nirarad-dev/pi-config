import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("Pi console navigation remains under the chat route", () => {
  assert.match(source, /return `\/chat\$\{query \? `\?\$\{query\}` : ""\}`/);
  assert.doesNotMatch(source, /router\.replace\("\/"/);
  assert.doesNotMatch(source, /router\.replace\(`\?session=/);
});

test("embedded Pi chat navigation preserves its presentation parameters", () => {
  assert.match(source, /if \(options\.embedded\) params\.set\("embedded", "1"\)/);
  assert.match(source, /if \(options\.sprintPilotPalette\) params\.set\("palette", "sprintpilot"\)/);
  assert.match(source, /if \(options\.scopeCwd\) params\.set\("scopeCwd", options\.scopeCwd\)/);
  assert.match(source, /display: embedded && !embeddedSessionSidebar \? "none" : "flex"/);
});

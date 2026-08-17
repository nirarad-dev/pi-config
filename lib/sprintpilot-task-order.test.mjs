import assert from "node:assert/strict";
import test from "node:test";
import { sortSprintTasks, sprintTaskGroup } from "./sprintpilot-config.ts";

const task = (key, status, epicKey, statusCategory) => ({
  key, status, epicKey, statusCategory, summary: key, priority: "Medium",
});

test("Jira statuses map onto the three rail groups", () => {
  assert.equal(sprintTaskGroup(task("A", "In CR")), "cr");
  assert.equal(sprintTaskGroup(task("B", "Code Review")), "cr");
  assert.equal(sprintTaskGroup(task("C", "in review")), "cr");
  assert.equal(sprintTaskGroup(task("D", "In Progress")), "progress");
  assert.equal(sprintTaskGroup(task("E", "Doing")), "progress");
  assert.equal(sprintTaskGroup(task("F", "To Do")), "backlog");
  assert.equal(sprintTaskGroup(task("G", "Selected")), "backlog");
});

test("an unrecognized status that Jira calls in-flight is treated as in progress", () => {
  assert.equal(sprintTaskGroup(task("H", "Awaiting deploy", undefined, "indeterminate")), "progress");
  assert.equal(sprintTaskGroup(task("I", "Awaiting triage", undefined, "new")), "backlog");
});

test("tasks sort as in CR, then in progress, then backlog", () => {
  const sorted = sortSprintTasks([
    task("BACKLOG", "To Do"),
    task("PROGRESS", "In Progress"),
    task("CR", "In CR"),
  ]);
  assert.deepEqual(sorted.map((item) => item.key), ["CR", "PROGRESS", "BACKLOG"]);
});

test("backlog clusters by epic while the active groups keep Jira rank order", () => {
  const sorted = sortSprintTasks([
    task("B1", "To Do", "EPIC-1"),
    task("B2", "To Do", "EPIC-2"),
    task("B3", "To Do", "EPIC-1"),
    task("P1", "In Progress", "EPIC-2"),
    task("P2", "In Progress", "EPIC-1"),
  ]);
  assert.deepEqual(sorted.map((item) => item.key), ["P1", "P2", "B1", "B3", "B2"]);
});

test("backlog tasks with no epic cluster together at the end", () => {
  const sorted = sortSprintTasks([
    task("NONE", "To Do", undefined),
    task("E1", "To Do", "EPIC-1"),
    task("E2", "To Do", "EPIC-1"),
  ]);
  assert.deepEqual(sorted.map((item) => item.key), ["E1", "E2", "NONE"]);
});

test("sorting does not mutate the incoming task list", () => {
  const tasks = [task("BACKLOG", "To Do"), task("CR", "In CR")];
  sortSprintTasks(tasks);
  assert.deepEqual(tasks.map((item) => item.key), ["BACKLOG", "CR"]);
});

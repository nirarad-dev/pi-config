import assert from "node:assert/strict";
import test from "node:test";
import { lastSpeakerFromTail } from "./sprintpilot-awaiting-reply.ts";

const message = (role, content = "hi") => JSON.stringify({ type: "message", id: "a1", message: { role, content } });

test("the agent speaking last means it is awaiting a reply", () => {
  assert.equal(lastSpeakerFromTail([message("user"), message("assistant")].join("\n")), "assistant");
});

test("the operator speaking last means nothing is pending", () => {
  assert.equal(lastSpeakerFromTail([message("assistant"), message("user")].join("\n")), "user");
});

test("tool results between turns do not count as a speaker", () => {
  const tail = [
    message("user"),
    message("assistant"),
    JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "t1" } }),
  ].join("\n");
  assert.equal(lastSpeakerFromTail(tail), "assistant");
});

test("non-message entries are ignored", () => {
  const tail = [
    message("assistant"),
    JSON.stringify({ type: "model_change", provider: "anthropic", modelId: "claude-opus-5" }),
    JSON.stringify({ type: "session_info", name: "renamed" }),
  ].join("\n");
  assert.equal(lastSpeakerFromTail(tail), "assistant");
});

test("a truncated first line from a mid-file read is skipped, not fatal", () => {
  const tail = ['ontent":"cut off mid json"}', message("user")].join("\n");
  assert.equal(lastSpeakerFromTail(tail), "user");
});

test("a tail with no messages reports no speaker", () => {
  assert.equal(lastSpeakerFromTail(""), undefined);
  assert.equal(lastSpeakerFromTail('{"type":"session","version":3}'), undefined);
});

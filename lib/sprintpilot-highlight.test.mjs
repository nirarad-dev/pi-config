import assert from "node:assert/strict";
import test from "node:test";
import { refractor } from "refractor/all";
import { configureSprintPilotPythonHighlighting, sprintPilotDiffTokenStyles } from "./sprintpilot-highlight.ts";

configureSprintPilotPythonHighlighting();

function tokensFor(source) {
  const tokens = new Map();
  const visit = (node) => {
    if (node.type === "element") {
      const text = node.children.map((child) => child.value || "").join("");
      tokens.set(text, node.properties.className);
      node.children.forEach(visit);
    }
  };
  refractor.highlight(source, "python").children.forEach(visit);
  return tokens;
}

test("adds semantic Python tokens omitted by the stock Prism grammar", () => {
  const tokens = tokensFor("class Policy(BasePolicy):\n    @classmethod\n    def check(cls, value: Decimal):\n        return cls.validate(value) <= MAX_LIMIT");

  assert.ok(tokens.get("BasePolicy").includes("class-reference"));
  assert.ok(tokens.get("Decimal").includes("class-reference"));
  assert.ok(tokens.get("cls").includes("self-reference"));
  assert.ok(tokens.get("validate").includes("function-call"));
  assert.ok(tokens.get("MAX_LIMIT").includes("python-constant"));
});

test("colors every added Python semantic category", () => {
  for (const token of ["class-reference", "python-constant", "function-call", "import-name", "property-access", "self-reference", "special-name", "decorator.annotation.punctuation"]) {
    assert.ok(sprintPilotDiffTokenStyles[token]?.color, `missing color for ${token}`);
  }
});

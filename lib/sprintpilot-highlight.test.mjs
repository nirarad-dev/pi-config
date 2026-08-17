import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("the inlined Python token colours stay in step with the theme palette", () => {
  // sprintpilot-highlight.ts cannot import the palette: it is loaded directly by
  // this test under node's type-stripping loader, which does not resolve the
  // extensionless relative imports the rest of lib/ uses. Assert agreement
  // instead, so a palette change cannot silently leave these behind.
  const theme = readFileSync(new URL("./sprintpilot-theme.ts", import.meta.url), "utf8");
  const palette = Object.fromEntries([...theme.matchAll(/(\w+): "(#[0-9a-f]{6})"/g)].map((m) => [m[1], m[2]]));
  const source = readFileSync(new URL("./sprintpilot-highlight.ts", import.meta.url), "utf8");
  const used = new Set([...source.matchAll(/color: "(#[0-9a-f]{6})"/g)].map((m) => m[1]));
  const known = new Set(Object.values(palette));
  for (const colour of used) {
    assert.ok(known.has(colour), `${colour} is not in the Cursor Dark palette`);
  }
  assert.equal(palette.yellow, "#ebcb8b");
  assert.ok(used.has(palette.cyan) && used.has(palette.magenta));
});

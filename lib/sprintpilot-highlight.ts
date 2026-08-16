import { refractor } from "refractor/all";

export const sprintPilotDiffTokenStyles = {
  "class-reference": { color: "#4ec9b0" },
  "class-reference.class-name": { color: "#4ec9b0" },
  "python-constant": { color: "#b5cea8" },
  "python-constant.constant": { color: "#b5cea8" },
  "function-call": { color: "#dcdcaa" },
  "function-call.function": { color: "#dcdcaa" },
  "import-name": { color: "#9cdcfe" },
  "import-name.namespace": { color: "#9cdcfe" },
  "property-access": { color: "#9cdcfe" },
  "property-access.property": { color: "#9cdcfe" },
  "self-reference": { color: "#c586c0" },
  "self-reference.variable": { color: "#c586c0" },
  "special-name": { color: "#d7ba7d" },
  "special-name.function": { color: "#d7ba7d" },
  decorator: { color: "#c586c0" },
  annotation: { color: "#c586c0" },
  "decorator.annotation.punctuation": { color: "#c586c0" },
};

export function configureSprintPilotPythonHighlighting(): void {
  const python = refractor.languages.python;
  if (!python || Object.hasOwn(python, "class-reference")) return;

  // Prism's stock Python grammar recognizes class declarations and function
  // declarations, but not semantic references commonly reviewed in Python.
  // Add the missing categories before broad keyword/boolean matching.
  refractor.languages.insertBefore("python", "keyword", {
    "python-constant": {
      pattern: /\b[A-Z][A-Z0-9_]{2,}\b/,
      alias: "constant",
    },
    "class-reference": {
      pattern: /\b(?!False\b|None\b|True\b)[A-Z][A-Za-z0-9_]*\b/,
      alias: "class-name",
    },
    "special-name": {
      pattern: /\b__[A-Za-z0-9_]+__\b/,
      alias: "function",
    },
    "self-reference": {
      pattern: /\b(?:cls|self)\b/,
      alias: "variable",
    },
    "import-name": {
      pattern: /(\b(?:from|import)\s+)[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/,
      lookbehind: true,
      alias: "namespace",
    },
  });

  // Insert after builtins so calls such as isinstance() retain their distinct
  // builtin color while ordinary calls and member access gain semantics.
  refractor.languages.insertBefore("python", "boolean", {
    "function-call": {
      pattern: /\b[A-Za-z_]\w*(?=\s*\()/,
      alias: "function",
    },
    "property-access": {
      pattern: /(\.)[A-Za-z_]\w*/,
      lookbehind: true,
      alias: "property",
    },
  });
}

configureSprintPilotPythonHighlighting();

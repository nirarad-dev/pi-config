import { refractor } from "refractor/all";

/**
 * Cursor Dark colours for the Python categories the stock Prism grammar does
 * not recognize, added below. They follow the same role mapping as the base
 * theme — yellow for types, purple for constants and `self`, cyan for callables
 * and namespaces, blue for decorators — so the extra categories are
 * indistinguishable from the theme's own tokens.
 *
 * The hex values are literals rather than an import of CURSOR_DARK: this module
 * is loaded directly by its unit test under node's type-stripping loader, which
 * cannot resolve the extensionless relative imports the rest of lib/ uses. The
 * test asserts the two files agree, so a change to the palette cannot drift.
 */
export const sprintPilotDiffTokenStyles = {
  "class-reference": { color: "#ebcb8b" },
  "class-reference.class-name": { color: "#ebcb8b" },
  "python-constant": { color: "#b48ead" },
  "python-constant.constant": { color: "#b48ead" },
  "function-call": { color: "#88c0d0" },
  "function-call.function": { color: "#88c0d0" },
  "import-name": { color: "#88c0d0" },
  "import-name.namespace": { color: "#88c0d0" },
  "property-access": { color: "#d8dee9" },
  "property-access.property": { color: "#d8dee9" },
  "self-reference": { color: "#b48ead" },
  "self-reference.variable": { color: "#b48ead" },
  "special-name": { color: "#88c0d0" },
  "special-name.function": { color: "#88c0d0" },
  decorator: { color: "#81a1c1" },
  annotation: { color: "#81a1c1" },
  "decorator.annotation.punctuation": { color: "#81a1c1" },
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

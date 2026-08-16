const DIFF_LANGUAGES: Record<string, string> = {
  py: "python",
  pyw: "python",
  pyi: "python",
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonl: "json",
  css: "css",
  scss: "scss",
  html: "markup",
  htm: "markup",
  xml: "markup",
  md: "markdown",
  mdx: "markdown",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
  go: "go",
  rs: "rust",
  java: "java",
  rb: "ruby",
};

export function sprintPilotDiffLanguage(filePath: string): string | undefined {
  const normalized = filePath.replace(/\\/g, "/");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
  if (name === "dockerfile") return "docker";
  if (name === "makefile") return "makefile";
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  return DIFF_LANGUAGES[extension];
}

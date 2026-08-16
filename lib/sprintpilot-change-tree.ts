export type SprintPilotChangeFile = {
  filePath: string;
  status: string;
};

export type SprintPilotChangeTreeNode =
  | { kind: "directory"; name: string; path: string; children: SprintPilotChangeTreeNode[]; fileCount: number }
  | { kind: "file"; name: string; path: string; status: string };

type MutableDirectory = {
  name: string;
  path: string;
  directories: Map<string, MutableDirectory>;
  files: Map<string, SprintPilotChangeTreeNode & { kind: "file" }>;
};

function createDirectory(name: string, path: string): MutableDirectory {
  return { name, path, directories: new Map(), files: new Map() };
}

function finalizeDirectory(directory: MutableDirectory): SprintPilotChangeTreeNode[] {
  const directories = [...directory.directories.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((child): SprintPilotChangeTreeNode => {
      const children = finalizeDirectory(child);
      const fileCount = children.reduce((count, node) => count + (node.kind === "file" ? 1 : node.fileCount), 0);
      return { kind: "directory", name: child.name, path: child.path, children, fileCount };
    });
  const files = [...directory.files.values()].sort((left, right) => left.name.localeCompare(right.name));
  return [...directories, ...files];
}

export function buildSprintPilotChangeTree(files: SprintPilotChangeFile[]): SprintPilotChangeTreeNode[] {
  const root = createDirectory("", "");

  for (const file of files) {
    const normalized = file.filePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const parts = normalized.split("/").filter(Boolean);
    const name = parts.pop();
    if (!name) continue;

    let directory = root;
    for (const part of parts) {
      const path = directory.path ? `${directory.path}/${part}` : part;
      let child = directory.directories.get(part);
      if (!child) {
        child = createDirectory(part, path);
        directory.directories.set(part, child);
      }
      directory = child;
    }
    directory.files.set(name, { kind: "file", name, path: normalized, status: file.status });
  }

  return finalizeDirectory(root);
}

export type SprintPilotHistoryLine =
  | { kind: "connector"; graph: string }
  | {
      kind: "commit";
      graph: string;
      hash: string;
      shortHash: string;
      parents: string[];
      refs: string[];
      author: string;
      authoredAt: string;
      subject: string;
    };

const RECORD_SEPARATOR = "\u001e";
const FIELD_SEPARATOR = "\u001f";

export const SPRINTPILOT_GIT_HISTORY_FORMAT = `%x1e%H%x1f%h%x1f%P%x1f%D%x1f%an%x1f%aI%x1f%s`;

export function parseSprintPilotGitHistory(output: string): SprintPilotHistoryLine[] {
  if (!output.trim()) return [];

  return output.split("\n").flatMap((line): SprintPilotHistoryLine[] => {
    const recordIndex = line.indexOf(RECORD_SEPARATOR);
    if (recordIndex < 0) return line ? [{ kind: "connector", graph: line }] : [];

    const graph = line.slice(0, recordIndex);
    const [hash = "", shortHash = "", parents = "", refs = "", author = "", authoredAt = "", ...subject] = line
      .slice(recordIndex + 1)
      .split(FIELD_SEPARATOR);

    return [{
      kind: "commit",
      graph,
      hash,
      shortHash,
      parents: parents ? parents.split(" ") : [],
      refs: refs ? refs.split(", ").filter(Boolean) : [],
      author,
      authoredAt,
      subject: subject.join(FIELD_SEPARATOR),
    }];
  });
}

import { existsSync } from "fs";
import { resolve } from "path";

/**
 * Absolute path to the bundled SprintPilot pi extension.
 *
 * Passed to the SDK as an `additionalExtensionPaths` entry rather than being
 * copied into `~/.pi/agent/extensions`. That keeps the extension versioned with
 * the app that depends on it, leaves the operator's global pi configuration
 * untouched, and never asks the reviewed repository to carry a
 * `.pi/extensions` directory of its own.
 *
 * The extension is inert outside a SprintPilot worktree, so loading it for
 * every session is safe; the gate lives in the extension, where it can be
 * resolved lazily against the session's real cwd.
 */
export function sprintPilotExtensionPath(): string | undefined {
  const root = process.cwd();
  const path = resolve(root, "extensions", "sprintpilot");
  // The extension imports its guard and prompt definitions from `lib/`, so both
  // must be present. Checking each one means a packaged install that shipped
  // only part of the tree degrades to the previous prompt-only behavior rather
  // than failing session startup with a module-resolution error.
  const required = [
    resolve(path, "index.ts"),
    resolve(root, "lib", "sprintpilot-git-guard.ts"),
    resolve(root, "lib", "sprintpilot-workflow-prompts.ts"),
  ];
  return required.every((file) => existsSync(file)) ? path : undefined;
}

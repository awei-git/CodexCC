import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";

import type { RepoContext } from "./types.js";

function tryGit(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function detectRepoContext(inputDir: string): RepoContext {
  const cwd = path.resolve(inputDir);
  const root = tryGit(["rev-parse", "--show-toplevel"], cwd) ?? cwd;
  const branch = tryGit(["rev-parse", "--abbrev-ref", "HEAD"], root) ?? "unknown";
  const dirty = (tryGit(["status", "--porcelain"], root) ?? "").length > 0;
  const hash = createHash("sha1").update(root).digest("hex");

  return { root, hash, branch, dirty };
}

export function readRepoDiff(root: string, maxChars = 12_000): string {
  const diff = tryGit(["diff", "--", "."], root);
  if (diff === null) {
    return "Not a git repository or git diff unavailable.";
  }
  if (!diff) {
    return "No unstaged diff.";
  }
  return diff.slice(0, maxChars);
}

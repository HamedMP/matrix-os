import { spawnSync } from "node:child_process";

export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const GIT_TIMEOUT_MS = 30_000;
export const GIT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
export const MAX_CHANGED_PATHS = 10_000;

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export function assertCommitSha(sha) {
  if (typeof sha !== "string" || !SHA_PATTERN.test(sha)) {
    throw new Error("Commit SHA is invalid");
  }
}

export function isGitAncestor(candidateSha, targetSha, { spawnGit = spawnSync } = {}) {
  assertCommitSha(candidateSha);
  assertCommitSha(targetSha);
  const result = spawnGit("git", ["merge-base", "--is-ancestor", candidateSha, targetSha], gitOptions());
  if (result.error) throw new Error("Git ancestry check failed");
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error("Git ancestry check failed");
}

export function readGitChangedPaths(baseSha, targetSha, { spawnGit = spawnSync } = {}) {
  assertCommitSha(baseSha);
  assertCommitSha(targetSha);
  const result = spawnGit(
    "git",
    ["diff", "--name-only", "--no-renames", "-z", `${baseSha}..${targetSha}`, "--"],
    gitOptions(),
  );
  if (result.error || result.status !== 0) {
    throw new Error("Git coverage diff failed");
  }
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const paths = stdout.split("\0").filter(Boolean);
  if (paths.length > MAX_CHANGED_PATHS) {
    throw new Error("Git coverage diff exceeds the changed-path limit");
  }
  return paths;
}

function gitOptions() {
  return {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER_BYTES,
  };
}

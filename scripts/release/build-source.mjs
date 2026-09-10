import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

const COMMIT = /^[a-f0-9]{40}$/;
const MAX_ANCESTORS = 256;

/** Capture the checkout being built; never infer ancestry from release dates. */
export function readBuildSource(root, expectedCommit) {
  const git = (...args) => execFileSync("git", args, {
    cwd: root, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const commit = git("rev-parse", "HEAD");
  if (!COMMIT.test(commit) || (expectedCommit && !COMMIT.test(expectedCommit))) {
    throw new Error("Build source must identify a full Git commit");
  }
  if (expectedCommit && expectedCommit !== commit) {
    throw new Error("Release commit does not match the checkout being built");
  }
  const changed = git("diff", "--name-only", "-z", "HEAD").split("\0").filter(Boolean);
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z");
  let dirty = Boolean(untracked || changed.length);
  // Release packaging stamps only package.version after checkout. Other edits
  // cannot be presented as the immutable source identified by HEAD.
  if (!untracked && changed.length === 1 && changed[0] === "desktop/package.json") {
    const original = JSON.parse(git("show", "HEAD:desktop/package.json"));
    const current = JSON.parse(readFileSync(join(root, "desktop/package.json"), "utf8"));
    const version = current.version;
    delete original.version;
    delete current.version;
    dirty = typeof version !== "string" || version.length > 128
      || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(version)
      || !isDeepStrictEqual(original, current);
  }
  if (dirty) {
    if (expectedCommit) throw new Error("Release checkout has uncommitted source changes");
    return null;
  }
  const history = git("rev-list", "--topo-order", `--max-count=${MAX_ANCESTORS + 1}`, "HEAD");
  const ancestors = history.split("\n").slice(1);
  if (ancestors.some((sha) => !COMMIT.test(sha))) throw new Error("Invalid build source history");
  return { commit, ancestors };
}

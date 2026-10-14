// Shell programs executed on the Matrix computer through POST /api/terminal/run.
// Every dynamic value travels as a positional argument to `sh -c`, never as
// interpolated script text, and is validated here before it is sent. The run
// endpoint starts in the Matrix home, so `pwd -P` names the home directory.

import { isSafeBranchName } from "./project-match.js";

export const UPLOAD_ID = /^handoff-[0-9]{12}-[a-f0-9]{12}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SAFE_ABSOLUTE_PATH = /^\/[A-Za-z0-9._@+\/-]{1,1024}$/;

export const HANDOFF_STAGE_DIR = "data/matrix-handoff";

export interface RemoteCommand {
  command: string[];
  cwd: string;
  timeoutMs: number;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertId(id: string) {
  assert(UPLOAD_ID.test(id), "Invalid handoff id");
}

function assertCommit(value: string, label: string) {
  assert(SHA1.test(value), `Invalid ${label}`);
}

function assertAbsolutePath(value: string) {
  assert(SAFE_ABSOLUTE_PATH.test(value) && !value.split("/").includes(".."), "Invalid Matrix path");
}

// Reassembles uploaded parts into one bundle and checks its digest.
const PRELUDE = `set -eu
export GIT_TERMINAL_PROMPT=0
home=$(pwd -P)
# Empty values travel as "-" because the run API rejects empty arguments.
v() { [ "$1" = "-" ] || printf '%s' "$1"; }
id=$(v "$1")
sha=$(v "$2")
stage="$home/${HANDOFF_STAGE_DIR}/$id"
bundle="$stage/handoff.bundle"
if [ ! -f "$bundle" ] && [ -n "$sha" ]; then
  cat "$stage"/bundle.part-[0-9][0-9][0-9][0-9] > "$bundle.tmp"
  mv "$bundle.tmp" "$bundle"
  rm -f "$stage"/bundle.part-[0-9][0-9][0-9][0-9]
fi
if [ -n "$sha" ]; then
  if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$bundle" | cut -d' ' -f1)
  else actual=$(shasum -a 256 "$bundle" | cut -d' ' -f1); fi
  [ "$actual" = "$sha" ] || { echo "result=bundle_corrupt"; exit 0; }
fi
inside_home() { case "$1" in "$home"/*) return 0;; *) return 1;; esac; }
`;

function script(body: string, args: string[]): string[] {
  return ["sh", "-c", `${PRELUDE}${body}`, "matrix-handoff", ...args.map((arg) => arg === "" ? "-" : arg)];
}

/** Creates ~/projects/<slug> from a full bundle for a project Matrix cannot clone. */
export function seedProjectCommand(input: {
  uploadId: string;
  bundleSha256: string;
  slug: string;
  branch: string;
  head: string;
  originUrl: string | null;
}): RemoteCommand {
  assertId(input.uploadId);
  assert(SHA256.test(input.bundleSha256), "Invalid bundle digest");
  assert(SLUG.test(input.slug), "Invalid project slug");
  assert(isSafeBranchName(input.branch), "Invalid branch");
  assertCommit(input.head, "head commit");
  const origin = input.originUrl ?? "";
  assert(origin.length <= 512 && !/[\u0000-\u001f\u007f]/.test(origin), "Invalid origin URL");
  const body = `slug=$(v "$3")
branch=$(v "$4")
head=$(v "$5")
origin=$(v "$6")
dest="$home/projects/$slug"
[ ! -e "$dest" ] || { echo "result=destination_exists"; exit 0; }
git init -q "$dest"
cd "$dest"
git fetch -q "$bundle" "+refs/matrix-handoff/$id/*:refs/matrix-handoff/$id/*"
git checkout -q -b "$branch" "$head"
[ -z "$origin" ] || git remote add origin "$origin"
echo "result=ok"
echo "path=$dest"
`;
  return {
    command: script(body, [input.uploadId, input.bundleSha256, input.slug, input.branch, input.head, origin]),
    cwd: "~",
    timeoutMs: 10 * 60_000,
  };
}

/**
 * Brings the handed-off commits into the project repository and decides the
 * branch the Chat will use. It fast-forwards a clean Matrix branch, and never
 * rewrites one that diverged or has uncommitted work; those cases land on the
 * side branch instead.
 */
export function integrateCommand(input: {
  uploadId: string;
  bundleSha256: string | null;
  repoPath: string;
  slug: string;
  branch: string;
  sideBranch: string;
  head: string;
  snapshot: string | null;
}): RemoteCommand {
  assertId(input.uploadId);
  assert(input.bundleSha256 === null || SHA256.test(input.bundleSha256), "Invalid bundle digest");
  assertAbsolutePath(input.repoPath);
  assert(SLUG.test(input.slug), "Invalid project slug");
  assert(isSafeBranchName(input.branch) && isSafeBranchName(input.sideBranch), "Invalid branch");
  assertCommit(input.head, "head commit");
  if (input.snapshot) assertCommit(input.snapshot, "snapshot commit");
  const body = `repo=$(v "$3")
slug=$(v "$4")
branch=$(v "$5")
side=$(v "$6")
head=$(v "$7")
snapshot=$(v "$8")
inside_home "$repo" || { echo "result=invalid_path"; exit 0; }
cd "$repo"
refs="refs/matrix-handoff/$id"
if [ -n "$sha" ]; then
  if ! git bundle verify -q "$bundle" >/dev/null 2>&1; then
    git fetch -q origin >/dev/null 2>&1 || true
    git bundle verify -q "$bundle" >/dev/null 2>&1 || { echo "result=needs_full_bundle"; exit 0; }
  fi
  git fetch -q "$bundle" "+$refs/*:$refs/*"
fi
if ! git cat-file -e "$head^{commit}" 2>/dev/null; then
  git fetch -q origin >/dev/null 2>&1 || true
  git cat-file -e "$head^{commit}" 2>/dev/null || { echo "result=needs_full_bundle"; exit 0; }
fi
checked_out_at() {
  git worktree list --porcelain | awk -v ref="branch refs/heads/$1" '/^worktree /{p=substr($0,10)} $0==ref{print p}'
}
is_dirty() { [ -n "$(git -C "$1" status --porcelain)" ]; }
target="$branch"
if cur=$(git rev-parse -q --verify "refs/heads/$branch^{commit}"); then
  if [ "$cur" != "$head" ]; then
    if git merge-base --is-ancestor "$cur" "$head"; then
      wt=$(checked_out_at "$branch")
      if [ -z "$wt" ]; then
        git update-ref "refs/heads/$branch" "$head" "$cur"
      elif ! is_dirty "$wt"; then
        git -C "$wt" merge -q --ff-only "$head"
      else
        target="$side"
      fi
    else
      target="$side"
    fi
  fi
else
  git branch "$branch" "$head"
fi
if [ "$target" = "$branch" ]; then
  wt=$(checked_out_at "$branch")
  if [ -n "$wt" ]; then
    if [ -n "$snapshot" ] && is_dirty "$wt"; then target="$side"; fi
    case "$wt" in
      "$repo"|"$home/worktrees/$slug/"*|"$home/projects/$slug/worktrees/"*) ;;
      *) target="$side" ;;
    esac
  fi
fi
[ "$target" = "$branch" ] || git branch "$target" "$head"
echo "result=ok"
echo "branch=$target"
echo "checkout=$(checked_out_at "$target")"
`;
  return {
    command: script(body, [
      input.uploadId,
      input.bundleSha256 ?? "",
      input.repoPath,
      input.slug,
      input.branch,
      input.sideBranch,
      input.head,
      input.snapshot ?? "",
    ]),
    cwd: "~",
    timeoutMs: 10 * 60_000,
  };
}

/** Applies the uncommitted snapshot in the target checkout, then removes staging. */
export function applySnapshotCommand(input: {
  uploadId: string;
  repoPath: string;
  checkoutPath: string;
  head: string;
  snapshot: string | null;
}): RemoteCommand {
  assertId(input.uploadId);
  assertAbsolutePath(input.repoPath);
  assertAbsolutePath(input.checkoutPath);
  assertCommit(input.head, "head commit");
  if (input.snapshot) assertCommit(input.snapshot, "snapshot commit");
  const body = `repo=$(v "$3")
checkout=$(v "$4")
head=$(v "$5")
snapshot=$(v "$6")
inside_home "$repo" && inside_home "$checkout" || { echo "result=invalid_path"; exit 0; }
cd "$checkout"
[ "$(git rev-parse HEAD)" = "$head" ] || { echo "result=checkout_moved"; exit 0; }
if [ -n "$snapshot" ]; then
  [ -z "$(git status --porcelain)" ] || { echo "result=checkout_dirty"; exit 0; }
  git diff --binary "$head" "$snapshot" | git apply --whitespace=nowarn
fi
echo "result=ok"
`;
  return {
    command: script(body, [input.uploadId, "", input.repoPath, input.checkoutPath, input.head, input.snapshot ?? ""]),
    cwd: "~",
    timeoutMs: 5 * 60_000,
  };
}

/** Removes temporary refs and the staging directory. Safe to run more than once. */
export function cleanupCommand(input: { uploadId: string; repoPath: string | null }): RemoteCommand {
  assertId(input.uploadId);
  if (input.repoPath) assertAbsolutePath(input.repoPath);
  const body = `repo=$(v "$3")
if [ -n "$repo" ] && inside_home "$repo" && [ -d "$repo" ]; then
  git -C "$repo" for-each-ref --format='%(refname)' "refs/matrix-handoff/$id/" | while read -r ref; do
    git -C "$repo" update-ref -d "$ref"
  done
fi
rm -rf "$stage"
echo "result=ok"
`;
  return {
    command: script(body, [input.uploadId, "", input.repoPath ?? ""]),
    cwd: "~",
    timeoutMs: 60_000,
  };
}

export function parseScriptOutput(stdout: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const match = /^(result|branch|checkout|path)=(.*)$/.exec(line.trim());
    if (match) result[match[1]!] = match[2]!;
  }
  return result;
}

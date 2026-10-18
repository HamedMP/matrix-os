/**
 * GIT_COMMIT_METADATA_FORMAT against real git: git keeps a unit separator
 * inside an author name, so the parser must still find the right name and
 * message. The bare repo is built with plumbing only in a temp dir, with fixed
 * identities and dates, through execFileSync with an argv array, a scrubbed
 * env, a timeout and a maxBuffer.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GIT_COMMIT_METADATA_FORMAT, parseCommitMetadata } from "../../packages/gateway/src/brain/git/parse.js";
import { GIT_ENV_OVERRIDES, GIT_GLOBAL_ARGS, GIT_SHA_PATTERN } from "../../packages/gateway/src/brain/git/types.js";

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 1024 * 1024;
/** Not UTC: newer git prints a zero offset as `Z`, older git as `+00:00`. */
const DATE = "2026-09-01T02:01:00+02:00";
const US = "\u001f";

let root = "";

function git(args: readonly string[], options: { input?: string; env?: Record<string, string> } = {}): Buffer {
  return execFileSync("git", [...GIT_GLOBAL_ARGS, ...args], {
    input: options.input ?? "",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, ...GIT_ENV_OVERRIDES, ...options.env },
  });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "brain-git-metadata-"));
});

afterAll(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
});

describe("GIT_COMMIT_METADATA_FORMAT", () => {
  it("keeps the author name and subject apart when both hold a unit separator", () => {
    const gitDir = join(root, "repo.git");
    git(["init", "-q", "--bare", gitDir]);
    const tree = git(["--git-dir", gitDir, "mktree"]).toString("latin1").trim();
    const sha = git(["--git-dir", gitDir, "commit-tree", tree], {
      input: `real${US}subject\n\nbody${US} text\n`,
      env: {
        GIT_AUTHOR_NAME: `Ann${US}Lee`, GIT_AUTHOR_EMAIL: "ann@example.com", GIT_AUTHOR_DATE: DATE,
        GIT_COMMITTER_NAME: "Fixture Committer", GIT_COMMITTER_EMAIL: "fixture@example.com", GIT_COMMITTER_DATE: DATE,
      },
    }).toString("latin1").trim();
    const stdout = git(["--git-dir", gitDir, "log", "-z", `--format=${GIT_COMMIT_METADATA_FORMAT}`, sha, "--"]);
    expect(stdout.includes(Buffer.from(`Ann${US}Lee`))).toBe(true);
    expect(parseCommitMetadata(stdout, { shaPattern: GIT_SHA_PATTERN.sha1, truncated: false })).toEqual([{
      sha, parents: [], committedAt: DATE, authoredAt: DATE, authorName: "AnnLee",
      subject: `real${US}subject`, body: `body${US} text`, messageTruncated: false,
    }]);
  });
});

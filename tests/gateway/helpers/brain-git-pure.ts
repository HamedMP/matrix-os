/**
 * Shared inputs and assertions for the pure git adapter suites (parse,
 * documents and mapping edges): byte builders, the GitSourceError code check,
 * parser wrappers, and the GitHub / GitLab web bases and document context.
 */
import { expect } from "vitest";
import { compileSpecGlobs, parseCommitMetadata, parseNameStatusLog } from "../../../packages/gateway/src/brain/git/parse.js";
import {
  GIT_SHA_PATTERN, GitSourceError,
  type GitDocumentContext, type GitSyncErrorCode, type GitWebBase,
} from "../../../packages/gateway/src/brain/git/types.js";

export const SHA1 = GIT_SHA_PATTERN.sha1;
export const A = "a".repeat(40);
export const B = "b".repeat(40);
export const C = "c".repeat(40);
/** The metadata log's field separator (%x1f). */
export const US = "\u001f";

export const GITHUB: GitWebBase = { href: "https://github.com/acme/widgets", flavor: "github" };
export const GITLAB: GitWebBase = { href: "https://gitlab.com/acme/platform/widgets", flavor: "gitlab" };
/** The GitHub base as identity, with the default spec glob. */
export const GITHUB_CTX: GitDocumentContext = {
  identity: GITHUB.href, webBase: GITHUB, matcher: compileSpecGlobs(["specs/*/spec.md"]),
};

/** UTF-8 strings and raw byte arrays, concatenated. */
export function bytes(...parts: Array<string | number[] | Uint8Array>): Uint8Array {
  return Buffer.concat(parts.map((part) => (typeof part === "string" ? Buffer.from(part, "utf8") : Buffer.from(part))));
}

/** `run` throws a GitSourceError with this code and the fixed message. */
export function expectGitCode(run: () => unknown, code: GitSyncErrorCode): void {
  let thrown: unknown = null;
  try {
    run();
  } catch (err: unknown) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(GitSourceError);
  expect((thrown as GitSourceError).code).toBe(code);
  expect((thrown as GitSourceError).message).toBe("Git source request failed");
}

export function meta(stdout: Uint8Array, truncated = false) {
  return parseCommitMetadata(stdout, { shaPattern: SHA1, truncated });
}

export function nameStatus(stdout: Uint8Array, options: { truncated?: boolean; isSpecPath?: (path: string) => boolean } = {}) {
  return parseNameStatusLog(stdout, {
    shaPattern: SHA1, isSpecPath: options.isSpecPath ?? (() => false), truncated: options.truncated ?? false,
  });
}

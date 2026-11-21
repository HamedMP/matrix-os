import { execFile } from "node:child_process";
import { DesktopDevRunSummarySchema, type DesktopDevRunSummary } from "../shared/dev-run-label";

export type GitReader = (args: string[]) => Promise<string>;
const GIT_TIMEOUT_MS = 2_000;

export function createGitReader(cwd: string): GitReader {
  return (args) => new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: 4096 }, (error, stdout) => {
      if (error) reject(error); else resolve(stdout.trim());
    });
  });
}

function toOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch (error: unknown) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

async function readOptional(readGit: GitReader, args: string[]): Promise<string | null> {
  try {
    return await readGit(args);
  } catch (error: unknown) {
    console.warn("[dev-run] git metadata unavailable:", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

/** Bounded, failure-tolerant dev-run identity; git metadata is dropped when unavailable or malformed. */
export async function resolveDesktopDevRunSummary(input: {
  label: string; platformOrigin?: string; apiOrigin?: string; readGit: GitReader;
}): Promise<DesktopDevRunSummary> {
  const [sha, branch] = await Promise.all([
    readOptional(input.readGit, ["rev-parse", "--short=12", "HEAD"]),
    readOptional(input.readGit, ["rev-parse", "--abbrev-ref", "HEAD"]),
  ]);
  const shape = DesktopDevRunSummarySchema.shape;
  const platformOrigin = toOrigin(input.platformOrigin);
  const apiOrigin = toOrigin(input.apiOrigin);
  return DesktopDevRunSummarySchema.parse({
    label: input.label,
    sha: shape.sha.safeParse(sha).success ? sha : null,
    branch: branch !== "HEAD" && shape.branch.safeParse(branch).success ? branch : null,
    platformOrigin: shape.platformOrigin.safeParse(platformOrigin).success ? platformOrigin : null,
    apiOrigin: apiOrigin !== platformOrigin && shape.apiOrigin.safeParse(apiOrigin).success ? apiOrigin : null,
  });
}

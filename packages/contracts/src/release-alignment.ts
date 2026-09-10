import { z } from "zod/v4";

const Commit = z.string().regex(/^[a-f0-9]{40}$/);
export const BuildSourceSchema = z.object({
  commit: Commit,
  ancestors: z.array(Commit).max(256),
}).refine(({ commit, ancestors }) => !ancestors.includes(commit)
  && ancestors.every((sha, index) => ancestors.indexOf(sha) === index));
export type BuildSource = z.infer<typeof BuildSourceSchema>;
export type ReleaseAlignmentStatus =
  | "aligned" | "runtime-update-required" | "different-releases" | "unavailable";

const RunningBuild = z.object({
  version: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  build: z.object({ sha: Commit }),
});

/** Uses the running gateway's process build identity, including older releases. */
export function readRunningCommit(info: unknown): string | null {
  const parsed = RunningBuild.safeParse(info);
  return parsed.success ? parsed.data.build.sha : null;
}

/** Release alignment is source identity, not a claim about every runtime feature. */
export function evaluateReleaseAlignment(info: unknown, desktopSource: unknown): ReleaseAlignmentStatus {
  const desktop = BuildSourceSchema.safeParse(desktopSource);
  const cloudCommit = readRunningCommit(info);
  if (!desktop.success || !cloudCommit) return "unavailable";
  if (desktop.data.commit === cloudCommit) return "aligned";
  if (desktop.data.ancestors.includes(cloudCommit)) return "runtime-update-required";
  // A newer cloud release, divergent branches, and history outside the bounded
  // ancestry window all differ. Do not guess their ordering from timestamps.
  return "different-releases";
}

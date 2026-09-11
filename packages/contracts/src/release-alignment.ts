import { z } from "zod/v4";
import { DESKTOP_PROTOCOL_VERSION, evaluateRuntimeCompatibility } from "#runtime-compatibility";

const Commit = z.string().regex(/^[a-f0-9]{40}$/);
export const BuildSourceSchema = z.object({
  commit: Commit,
  ancestors: z.array(Commit).max(256),
}).refine(({ commit, ancestors }) => !ancestors.includes(commit)
  && ancestors.every((sha, index) => ancestors.indexOf(sha) === index));
export type BuildSource = z.infer<typeof BuildSourceSchema>;
export type ReleaseAlignmentStatus =
  | "aligned" | "runtime-update-required" | "different-releases" | "unavailable";

const Version = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const RunningBuild = z.object({
  version: Version,
  build: z.object({ sha: Commit }),
});
const RunningHostRelease = z.object({
  version: Version,
  runningVersion: Version,
  release: z.object({
    schemaVersion: z.literal(1),
    kind: z.literal("matrix-os-host-bundle"),
    version: Version,
    gitCommit: Commit,
  }),
}).refine(({ version, runningVersion, release }) =>
  version === runningVersion && release.version === runningVersion);

/** Image builds expose an env SHA; native host bundles expose release.json. */
export function readRunningCommit(info: unknown): string | null {
  const parsed = RunningBuild.safeParse(info);
  if (parsed.success) return parsed.data.build.sha;
  // release.json may already describe the next installation. Its immutable
  // version must match the process-start version before using its commit.
  // installedVersion is template/package metadata, not process provenance.
  const host = RunningHostRelease.safeParse(info);
  return host.success ? host.data.release.gitCommit : null;
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

/** Supported protocols do not prove alignment; unsupported ones retain recovery. */
export function evaluateDesktopReleaseState(info: unknown, desktopSource: unknown,
  desktopProtocol = DESKTOP_PROTOCOL_VERSION) {
  const alignment = evaluateReleaseAlignment(info, desktopSource);
  const protocol = evaluateRuntimeCompatibility(info, desktopProtocol);
  const status = protocol === "desktop-update-required" || protocol === "runtime-update-required"
    ? protocol : alignment;
  return { alignment, protocol, status };
}

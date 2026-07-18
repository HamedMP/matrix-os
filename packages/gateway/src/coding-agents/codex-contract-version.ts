import { z } from "zod/v4";

const CodexVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);

export type CodexContractStatus =
  | { status: "verified"; version: string }
  | { status: "unverified_older"; version: string }
  | { status: "unverified_newer"; version: string }
  | { status: "invalid" };

function versionTuple(version: string): readonly [number, number, number] {
  const [major, minor, patch] = version.split(".").map(Number);
  return [major!, minor!, patch!];
}

function compareVersions(left: string, right: string): number {
  const leftParts = versionTuple(left);
  const rightParts = versionTuple(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

export function codexContractStatus(
  versionOutput: string,
  contract: { latestVerifiedVersion: string; verifiedVersions: Record<string, unknown> },
): CodexContractStatus {
  const match = versionOutput.trim().match(/(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/);
  const parsed = CodexVersionSchema.safeParse(match?.[1]);
  if (!parsed.success) return { status: "invalid" };
  const version = parsed.data;
  if (Object.hasOwn(contract.verifiedVersions, version)) return { status: "verified", version };
  if (compareVersions(version, contract.latestVerifiedVersion) > 0) {
    return { status: "unverified_newer", version };
  }
  return { status: "unverified_older", version };
}

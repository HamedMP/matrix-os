import { z } from "zod/v4";
import contract from "./codex-exec-contract.json" with { type: "json" };

const CodexVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);

const CodexExecContractSchema = z.object({
  packageName: z.literal("@openai/codex"),
  minimumVersion: CodexVersionSchema,
  latestVerifiedVersion: CodexVersionSchema,
  schemaSha256: z.string().regex(/^[a-f0-9]{64}$/),
  requiredEventTypes: z.array(z.string().min(1).max(80)).min(1).max(32),
}).strict();

export const CODEX_EXEC_CONTRACT = CodexExecContractSchema.parse(contract);

type ContractStatus =
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

export function codexExecContractStatus(versionOutput: string): ContractStatus {
  const match = versionOutput.trim().match(/(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/);
  const parsed = CodexVersionSchema.safeParse(match?.[1]);
  if (!parsed.success) return { status: "invalid" };
  const version = parsed.data;
  if (compareVersions(version, CODEX_EXEC_CONTRACT.minimumVersion) < 0) {
    return { status: "unverified_older", version };
  }
  if (compareVersions(version, CODEX_EXEC_CONTRACT.latestVerifiedVersion) > 0) {
    return { status: "unverified_newer", version };
  }
  return { status: "verified", version };
}

import { z } from "zod/v4";
import contract from "./codex-exec-contract.json" with { type: "json" };
import { codexContractStatus, type CodexContractStatus } from "./codex-contract-version.js";

const CodexVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);

const CodexExecContractSchema = z.object({
  packageName: z.literal("@openai/codex"),
  minimumVersion: CodexVersionSchema,
  latestVerifiedVersion: CodexVersionSchema,
  schemaSha256: z.string().regex(/^[a-f0-9]{64}$/),
  requiredEventTypes: z.array(z.string().min(1).max(80)).min(1).max(32),
}).strict();

export const CODEX_EXEC_CONTRACT = CodexExecContractSchema.parse(contract);

export function codexExecContractStatus(versionOutput: string): CodexContractStatus {
  return codexContractStatus(versionOutput, CODEX_EXEC_CONTRACT);
}

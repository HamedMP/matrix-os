import { z } from "zod/v4";
import contract from "./codex-app-server-contract.json" with { type: "json" };
import { codexContractStatus, type CodexContractStatus } from "./codex-contract-version.js";

const CodexVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const SchemaDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const SchemaVerificationSchema = z.union([
  z.object({
    schemaSha256: SchemaDigestSchema,
  }).strict(),
  z.object({
    schemaSha256ByTarget: z.record(
      z.string().regex(/^[a-z0-9]+-[a-z0-9]+$/),
      SchemaDigestSchema,
    ),
  }).strict(),
]);

const CodexAppServerContractSchema = z.object({
  packageName: z.literal("@openai/codex"),
  latestVerifiedVersion: CodexVersionSchema,
  experimental: z.literal(true),
  verifiedVersions: z.record(CodexVersionSchema, SchemaVerificationSchema),
  requiredServerMethods: z.array(z.string().min(1).max(100)).min(1).max(16),
  requiredServerNotifications: z.array(z.string().min(1).max(100)).min(1).max(16),
}).strict().refine(
  (value) => Object.hasOwn(value.verifiedVersions, value.latestVerifiedVersion),
  { message: "Latest Codex app-server version must have a verified schema" },
);

export const CODEX_APP_SERVER_CONTRACT = CodexAppServerContractSchema.parse(contract);

export function codexAppServerContractStatus(versionOutput: string): CodexContractStatus {
  return codexContractStatus(versionOutput, CODEX_APP_SERVER_CONTRACT);
}

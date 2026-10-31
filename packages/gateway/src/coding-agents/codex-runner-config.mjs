import { CodexBrowserLeaseSchema } from "./codex-browser-bootstrap.mjs";
import { z } from "zod/v4";
import { isAbsolute } from "node:path";
const NativeReferenceSchema = z.string().min(1).max(512);
// This runner is executed directly by plain Node, so keep this boundary schema
// aligned with ProviderModelReferenceSchema from @matrix-os/contracts.
const ProviderModelReferenceSchema = z.string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.:-]*)*$/)
  .refine((value) => !value.includes(".."));
export const RunnerConfigSchema = z.object({
  routinePrivate: z.literal(true).optional(),
  nativeSubscription: z.literal(true).optional(),
  expectedNativePrincipal: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  expectedNativeConsent: z.object({ revision: z.number().int().nonnegative(),
    harnessInstanceId: z.string().min(1).max(128), accountId: z.string().min(1).max(128),
    configurationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().optional(),
  prompt: z.string().trim().min(1).max(64 * 1024),
  providerThreadId: NativeReferenceSchema.optional(),
  browserAttemptId: z.uuid().optional(),
  approvalPolicy: z.enum(["untrusted", "on-request", "never"]),
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]),
  writableRoots: z.array(z.string().min(1).max(4096).refine(isAbsolute)).max(20),
  model: ProviderModelReferenceSchema.optional(),
  effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
  serviceTier: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/).optional(),
}).strict();
export const ModelOptionSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/),
  value: z.union([
    z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/),
    z.boolean(),
  ]),
}).strict();
export const PendingTurnSchema = z.object({
  prompt: z.string().trim().min(1).max(64 * 1024),
  model: RunnerConfigSchema.shape.model,
  modelOptions: z.array(ModelOptionSchema).max(32).default([]),
  browser: CodexBrowserLeaseSchema.nullable().optional(),
}).strict();
export const EffortSchema = RunnerConfigSchema.shape.effort;
export const ServiceTierSchema = RunnerConfigSchema.shape.serviceTier;

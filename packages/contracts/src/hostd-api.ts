import { z } from "zod/v4";

// Wire contract of the metal host agent API (hostd, port 8443, spec 2691 /
// ENG-520). The platform client parses every hostd answer with these schemas.
// hostd currently keeps its own copies in packages/hostd/src/api.ts; it should
// adopt these once both live on main.

export const HOSTD_MAX_RESUME_BUDGET_MS = 15_000;

export const HostdVmIdSchema = z.string().regex(/^vm_[0-9a-f]{24}$/);

export const HostdErrorCodeSchema = z.enum([
  "unauthorized", "bad_request", "not_found", "busy", "pool_full", "conflict", "internal",
]);
export type HostdErrorCode = z.infer<typeof HostdErrorCodeSchema>;

export const HostdErrorBodySchema = z.object({ error: HostdErrorCodeSchema });

export const HostdVmTierSchema = z.enum(["free", "paid"]);
export const HostdVmStateSchema = z.enum([
  "creating", "running", "suspending", "suspended", "resuming", "stopped", "failed",
]);
export type HostdVmState = z.infer<typeof HostdVmStateSchema>;

const mib = (max: number) => z.int().min(512).max(max).multipleOf(128);

export const HostdCreateVmRequestSchema = z.strictObject({
  machineId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  generation: z.int().min(0),
  handle: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  tier: HostdVmTierSchema,
  bootMiB: mib(65_536),
  maxMiB: mib(131_072),
  diskGiB: z.int().min(1).max(1024),
  userData: z.string().refine((value) => new TextEncoder().encode(value).byteLength <= 64 * 1024),
  goldenVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
});
export type HostdCreateVmRequest = z.infer<typeof HostdCreateVmRequestSchema>;

export const HostdCreateVmResponseSchema = z.object({
  id: HostdVmIdSchema,
  privateIPv4: z.string().max(64),
  state: z.literal("creating").optional(),
});
export type HostdCreateVmResponse = z.infer<typeof HostdCreateVmResponseSchema>;

/** The platform generation a resume or suspend is fenced to; hostd answers 409 on a mismatch. */
export const HostdExpectedGenerationSchema = z.int().min(1);

export const HostdResumeRequestSchema = z.strictObject({
  budgetMs: z.int().min(0).max(HOSTD_MAX_RESUME_BUDGET_MS),
  expectedGeneration: HostdExpectedGenerationSchema.optional(),
});

export const HostdSuspendRequestSchema = z.strictObject({
  expectedGeneration: HostdExpectedGenerationSchema.optional(),
});

export const HostdResumeResponseSchema = z.object({ state: z.enum(["running", "starting"]) });
export type HostdResumeResponse = z.infer<typeof HostdResumeResponseSchema>;

export const HostdSuspendResponseSchema = z.object({ state: z.literal("suspending") });
export type HostdSuspendResponse = z.infer<typeof HostdSuspendResponseSchema>;

export const HostdStopResponseSchema = z.object({ state: HostdVmStateSchema });
export type HostdStopResponse = z.infer<typeof HostdStopResponseSchema>;

export const HostdPolicyRequestSchema = z.strictObject({ tier: HostdVmTierSchema, maxMiB: mib(131_072) });
export type HostdPolicyRequest = z.infer<typeof HostdPolicyRequestSchema>;

export const HostdVmSchema = z.object({
  id: HostdVmIdSchema,
  machineId: z.string().max(128),
  generation: z.int().min(0),
  handle: z.string().max(63),
  tier: HostdVmTierSchema,
  state: HostdVmStateSchema,
  privateIPv4: z.string().max(64),
  bootMiB: z.int().positive(),
  maxMiB: z.int().positive(),
  diskGiB: z.int().positive(),
  chVersion: z.string().max(64),
  snapshot: z.object({ takenAt: z.string().max(64), chVersion: z.string().max(64) }).nullable(),
  updatedAt: z.string().max(64),
  failedDuring: z.enum(["create", "runtime"]).optional(),
});
export type HostdVm = z.infer<typeof HostdVmSchema>;

export const HostdListVmsResponseSchema = z.object({ vms: z.array(HostdVmSchema).max(4096) });

export const HostdCapacityResponseSchema = z.object({
  memoryAvailableMiB: z.number().nonnegative(),
  poolFreeBytes: z.number().nonnegative(),
  runningVms: z.int().nonnegative(),
  suspendedVms: z.int().nonnegative(),
});
export type HostdCapacityResponse = z.infer<typeof HostdCapacityResponseSchema>;

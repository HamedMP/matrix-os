import { z } from "zod/v4";

/** Free owned machines an account may enroll (spec 2707, D5). */
export const OWNED_MACHINE_LIMIT_PER_ACCOUNT = 3;
/** A heartbeat older than this marks the machine offline. */
export const OWNED_MACHINE_HEARTBEAT_FRESH_MS = 90_000;
export const OWNED_MACHINE_HEARTBEAT_INTERVAL_MS = 30_000;
export const OWNED_MACHINE_ENROLLMENT_TTL_SECONDS = 900;
export const OWNED_MACHINE_ENROLLMENT_POLL_SECONDS = 5;

const PRINTABLE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;

export const OwnedMachineRuntimeSlotSchema = z.string().regex(/^owned-[0-9a-f]{8}$/);
export const OwnedMachineArchSchema = z.enum(["x86_64", "arm64"]);
export const OwnedMachineUserCodeSchema = z.string().trim().toUpperCase()
  .transform((value) => value.replace(/[\s-]/g, ""))
  .pipe(z.string().regex(/^[BCDFGHJKLMNPQRSTVWXZ]{8}$/));
export const OwnedMachineDeviceCodeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const OwnedMachineTunnelTokenSchema = z.string().min(1).max(4096).regex(/^[A-Za-z0-9_=+/.-]+$/);
export const OwnedMachineNameSchema = z.string().trim().min(1).max(64).regex(PRINTABLE);

export const OwnedMachineReportSchema = z.object({
  hostname: z.string().min(1).max(253).regex(PRINTABLE),
  os: z.string().min(1).max(64).regex(PRINTABLE),
  arch: OwnedMachineArchSchema,
  agentVersion: z.string().min(1).max(64).regex(/^[0-9A-Za-z._+-]+$/),
}).strict();
export type OwnedMachineReport = z.infer<typeof OwnedMachineReportSchema>;

export const OwnedEnrollStartRequestSchema = OwnedMachineReportSchema;

export const OwnedEnrollStartResponseSchema = z.object({
  deviceCode: OwnedMachineDeviceCodeSchema,
  userCode: z.string().regex(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/),
  verificationUri: z.url(),
  verificationUriComplete: z.url(),
  expiresIn: z.number().int().positive(),
  interval: z.number().int().positive(),
}).strict();
export type OwnedEnrollStartResponse = z.infer<typeof OwnedEnrollStartResponseSchema>;

export const OwnedEnrollPollRequestSchema = z.object({ deviceCode: OwnedMachineDeviceCodeSchema }).strict();

/** Environment keys the platform may hand to an owned machine. Nothing else is accepted. */
export const OWNED_MACHINE_ENV_KEYS = [
  "MATRIX_MACHINE_ID", "MATRIX_CLERK_USER_ID", "MATRIX_HANDLE", "MATRIX_RUNTIME_SLOT",
  "MATRIX_RUNTIME_TOKEN_EPOCH", "MATRIX_SUBSTRATE", "MATRIX_UPDATE_CHANNEL", "PLATFORM_INTERNAL_URL",
  "UPGRADE_TOKEN", "MATRIX_AUTH_TOKEN", "MATRIX_CODE_PROXY_TOKEN", "MATRIX_SYNC_RUNTIME_TOKEN",
  "MATRIX_FUNDED_AI_RUNTIME_TOKEN", "MATRIX_FUNDED_AI_ENABLED", "MATRIX_FUNDED_AI_RELAY_URL",
  "MATRIX_PLATFORM_SPEECH_ENABLED", "MATRIX_PLATFORM_SPEECH_ORIGIN", "MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN",
] as const;
export type OwnedMachineEnvKey = (typeof OWNED_MACHINE_ENV_KEYS)[number];
const ENV_VALUE = z.string().max(2048).regex(/^[^\0\r\n'"\\$`]*$/);
export const OwnedMachineEnvSchema = z.object(
  Object.fromEntries(OWNED_MACHINE_ENV_KEYS.map((key) => [key, ENV_VALUE])) as Record<OwnedMachineEnvKey, typeof ENV_VALUE>,
).strict();

export const OwnedEnrollPollResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }).strict(),
  z.object({ status: z.literal("slow_down") }).strict(),
  z.object({ status: z.literal("expired") }).strict(),
  z.object({ status: z.literal("denied") }).strict(),
  z.object({
    status: z.literal("ready"),
    machineId: z.string().uuid(),
    tunnelToken: OwnedMachineTunnelTokenSchema,
    env: OwnedMachineEnvSchema,
  }).strict(),
]);
export type OwnedEnrollPollResponse = z.infer<typeof OwnedEnrollPollResponseSchema>;

export const OwnedMachineHeartbeatRequestSchema = z.object({
  agentVersion: OwnedMachineReportSchema.shape.agentVersion,
  uptimeSec: z.number().int().min(0).max(10 * 365 * 86_400),
  diskFreeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  gatewayHealthy: z.boolean(),
}).strict();

export const OwnedMachineHeartbeatResponseSchema = z.object({
  status: z.literal("ok"),
  tunnel: z.enum(["ok", "reissue"]),
  autoSecurityUpdates: z.boolean(),
  backupsEnabled: z.boolean(),
}).strict();
export type OwnedMachineHeartbeatResponse = z.infer<typeof OwnedMachineHeartbeatResponseSchema>;

export const OwnedMachineTunnelResponseSchema = z.object({
  tunnelToken: OwnedMachineTunnelTokenSchema,
}).strict();

export const OwnedComputerStatusSchema = z.enum(["enrolling", "online", "offline"]);
export type OwnedComputerStatus = z.infer<typeof OwnedComputerStatusSchema>;

export const OwnedComputerSummarySchema = z.object({
  machineId: z.string().uuid(),
  handle: z.string(),
  runtimeSlot: OwnedMachineRuntimeSlotSchema,
  name: OwnedMachineNameSchema,
  status: OwnedComputerStatusSchema,
  lastSeenAt: z.string().nullable(),
  os: z.string().nullable(),
  arch: OwnedMachineArchSchema.nullable(),
  agentVersion: z.string().nullable(),
  autoSecurityUpdates: z.boolean(),
  backupsEnabled: z.boolean(),
}).strict();
export type OwnedComputerSummary = z.infer<typeof OwnedComputerSummarySchema>;

export const OwnedComputerListResponseSchema = z.object({
  computers: z.array(OwnedComputerSummarySchema).max(OWNED_MACHINE_LIMIT_PER_ACCOUNT),
  limit: z.number().int().positive(),
}).strict();

export const OwnedComputerUpdateRequestSchema = z.object({
  name: OwnedMachineNameSchema.optional(),
  autoSecurityUpdates: z.boolean().optional(),
  backupsEnabled: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0);

export const OwnedEnrollApproveRequestSchema = z.object({
  userCode: OwnedMachineUserCodeSchema,
  name: OwnedMachineNameSchema,
}).strict();

export const OwnedEnrollLookupResponseSchema = z.object({
  userCode: z.string(),
  report: OwnedMachineReportSchema,
  expiresAt: z.string(),
}).strict();

import { randomBytes } from 'node:crypto';
import { z } from 'zod/v4';
export const RuntimeIdSchema = z.string().regex(/^[0-9a-f]{32}$/);
export const OperationIdSchema = z.string().regex(/^[0-9a-f]{32}$/);
export const DisplayNameSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const MetadataRevisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const GenerationSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const IsoTimestampSchema = z.string().datetime({ offset: true });
export const HomeRelativePathSchema = z.string()
  .max(4096)
  .refine((value) => {
    if (value === '') return true;
    if (value.startsWith('/') || value.includes('\0') || value.includes('\\')) return false;
    return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
  }, 'path must be owner-home relative');
export const HomeRelativeCwdSchema = z.object({
  kind: z.literal('home-relative'),
  path: HomeRelativePathSchema,
}).strict();
export const LifecycleStateSchema = z.enum(['starting', 'live', 'interrupted',
  'recoverable', 'recovering', 'deleting', 'exited', 'failed']);
export const RecoveryReasonSchema = z.enum(['cwd_unavailable',
  'history_unavailable', 'unsupported_state', 'metadata_corrupt',
  'runtime_lost', 'startup_failed']);
export const LaunchDataSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('shell') }).strict(),
  z.object({
    kind: z.literal('agent'),
    // The provider configuration travels on an inherited anonymous FD in the
    // supervised launcher. This opaque correlation ID is not a provider name,
    // executable, prompt, credential, path, or environment value.
    configurationRef: OperationIdSchema,
  }).strict(),
]);
export const ReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  runtimeId: RuntimeIdSchema,
  displayName: DisplayNameSchema,
  cwd: HomeRelativeCwdSchema,
  createdAt: IsoTimestampSchema,
  metadataRevision: MetadataRevisionSchema,
  lastKnown: z.object({
    state: LifecycleStateSchema,
    at: IsoTimestampSchema,
    bootId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
  }).strict(),
  zellij: z.object({
    sessionName: z.string().regex(/^matrix-t-[0-9a-f]{32}$/),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.zellij.sessionName !== `matrix-t-${value.runtimeId}`) {
    context.addIssue({
      code: 'custom',
      path: ['zellij', 'sessionName'],
      message: 'session identity must match runtime identity',
    });
  }
});
const NameTargetSchema = z.object({
  runtimeId: RuntimeIdSchema,
  metadataRevision: MetadataRevisionSchema,
}).strict();
const AliasTargetSchema = z.object({
  runtimeId: RuntimeIdSchema,
  expiresAt: IsoTimestampSchema,
}).strict();
export const NameIndexSchema = z.object({
  schemaVersion: z.literal(1),
  canonical: z.record(DisplayNameSchema, NameTargetSchema),
  aliases: z.record(DisplayNameSchema, AliasTargetSchema),
}).strict();
export const OperationRecordSchema = z.object({
  schemaVersion: z.literal(1),
  operationId: OperationIdSchema,
  runtimeId: RuntimeIdSchema.nullable(),
  generation: GenerationSchema,
  intent: z.enum(['create', 'recover', 'rename', 'delete', 'reconcile']),
  status: z.enum(['accepted', 'claimed', 'ready', 'failed']),
  requestHash: z.string().regex(/^[0-9a-f]{64}$/),
  committedAt: IsoTimestampSchema,
  result: z.unknown().optional(),
}).strict();
export const DescriptorSchema = z.object({
  schemaVersion: z.literal(1),
  runtimeId: RuntimeIdSchema,
  operationId: OperationIdSchema,
  intent: z.enum(['create', 'recover']),
  cwd: HomeRelativeCwdSchema,
  launch: LaunchDataSchema,
  createdAt: IsoTimestampSchema,
}).strict();
const RequestBase = {
  version: z.literal(1),
  operationId: OperationIdSchema,
};
export const ProtocolRequestSchema = z.discriminatedUnion('operation', [
  z.object({
    ...RequestBase,
    operation: z.literal('CreateStart'),
    input: z.object({
      displayName: DisplayNameSchema,
      cwd: HomeRelativeCwdSchema.optional(),
      launch: LaunchDataSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...RequestBase,
    operation: z.literal('Inspect'),
    input: z.object({ runtimeId: RuntimeIdSchema }).strict(),
  }).strict(),
  z.object({
    ...RequestBase,
    operation: z.literal('List'),
    input: z.object({}).strict(),
  }).strict(),
  z.object({
    ...RequestBase,
    operation: z.literal('Recover'),
    input: z.object({ runtimeId: RuntimeIdSchema }).strict(),
  }).strict(),
  z.object({
    ...RequestBase,
    operation: z.literal('RenameMetadata'),
    input: z.object({
      runtimeId: RuntimeIdSchema,
      displayName: DisplayNameSchema,
      baseRevision: MetadataRevisionSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...RequestBase,
    operation: z.literal('Delete'),
    input: z.object({ runtimeId: RuntimeIdSchema }).strict(),
  }).strict(),
  z.object({
    ...RequestBase,
    operation: z.literal('Reconcile'),
    input: z.object({}).strict(),
  }).strict(),
]);
export const ProtocolErrorCodeSchema = z.enum([
  'invalid_request', 'not_found', 'conflict', 'unavailable', 'failed',
]);
export const ProtocolResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    version: z.literal(1),
    ok: z.literal(true),
    operationId: OperationIdSchema,
    result: z.unknown(),
  }).strict(),
  z.object({
    version: z.literal(1),
    ok: z.literal(false),
    operationId: OperationIdSchema.optional(),
    error: z.object({
      code: ProtocolErrorCodeSchema,
      message: z.string().min(1).max(128),
    }).strict(),
  }).strict(),
]);
export type RuntimeId = z.infer<typeof RuntimeIdSchema>;
export type OperationId = z.infer<typeof OperationIdSchema>;
export type Receipt = z.infer<typeof ReceiptSchema>;
export type NameIndex = z.infer<typeof NameIndexSchema>;
export type OperationRecord = z.infer<typeof OperationRecordSchema>;
export type Descriptor = z.infer<typeof DescriptorSchema>;
export type HomeRelativeCwd = z.infer<typeof HomeRelativeCwdSchema>;
export type ProtocolRequest = z.infer<typeof ProtocolRequestSchema>;
export type ProtocolResponse = z.infer<typeof ProtocolResponseSchema>;
export type LifecycleState = z.infer<typeof LifecycleStateSchema>;
export type RecoveryReason = z.infer<typeof RecoveryReasonSchema>;
export function createRuntimeId(): RuntimeId {
  return RuntimeIdSchema.parse(randomBytes(16).toString('hex'));
}
export function createOperationId(): OperationId {
  return OperationIdSchema.parse(randomBytes(16).toString('hex'));
}
export function unitNameForRuntimeId(runtimeId: string): string {
  const trustedId = RuntimeIdSchema.parse(runtimeId);
  return `matrix-terminal-session@${trustedId}.service`;
}

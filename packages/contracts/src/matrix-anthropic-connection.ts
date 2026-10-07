import { z } from "zod/v4";

export const MATRIX_ANTHROPIC_CONNECTION_ID = "matrix_anthropic_api" as const;
export const MatrixAnthropicCredentialGenerationSchema = z.uuid();
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ref = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const generation = MatrixAnthropicCredentialGenerationSchema.nullable();
const mutation = { expectedRevision: revision, expectedCredentialGeneration: generation, idempotencyKey: ref };

export const MatrixAnthropicConnectSchema = z.object({ ...mutation,
  apiKey: z.string().trim().min(8).max(4096).refine(value => !/[\r\n\0]/.test(value)),
}).strict();
export const MatrixAnthropicDisconnectSchema = z.object(mutation).strict();
export const MatrixAnthropicRefreshSchema = z.object(mutation).strict();
export const MatrixAnthropicSourceStateSchema = z.object({ version: z.literal(1), revision, enabled: z.boolean(), credentialGeneration: generation })
  .strict().refine(state => !state.enabled || state.credentialGeneration !== null, { message: "Enabled source requires an explicit credential generation" });

export const MatrixAnthropicConnectionSchema = z.object({
  connectionId: z.literal(MATRIX_ANTHROPIC_CONNECTION_ID), providerId: z.literal("anthropic"),
  executionKind: z.literal("direct_pi"), billingKind: z.literal("api_key"),
  revision, enabled: z.boolean(), credentialGeneration: generation, sourceCredentialGeneration: generation,
  state: z.enum(["unsupported", "read_only", "disconnected", "auth_required", "refresh_required", "ready", "unavailable"]),
  models: z.array(z.object({ id: ref, displayName: z.string().min(1).max(120).regex(/^[^\u0000-\u001f\u007f]+$/) }).strict()).max(256),
  actions: z.array(z.enum(["connect", "refresh", "disconnect"])).max(3),
  checkedAt: z.iso.datetime().nullable(), staleAfter: z.iso.datetime().nullable(),
  supports: z.object({ rootChat: z.boolean(), recipeBots: z.boolean() }).strict(),
}).strict().superRefine((status, context) => {
  const invalid = () => context.addIssue({ code: "custom", message: "Invalid Matrix connection authority" });
  if (new Set(status.models.map(model => model.id)).size !== status.models.length
    || new Set(status.actions).size !== status.actions.length) invalid();
  if (status.state === "ready") {
    if (!status.enabled || !status.credentialGeneration || status.sourceCredentialGeneration !== status.credentialGeneration
      || !status.models.length || !status.checkedAt || !status.staleAfter
      || Date.parse(status.staleAfter) <= Date.parse(status.checkedAt)) invalid();
  } else if (status.models.length) invalid();
  if (status.state === "disconnected" && status.enabled) invalid();
  if ((status.state === "unsupported" || status.state === "read_only")
    && (status.actions.length || status.supports.rootChat || status.supports.recipeBots)) invalid();
});

export type MatrixAnthropicConnection = z.infer<typeof MatrixAnthropicConnectionSchema>;
export type MatrixAnthropicConnect = z.infer<typeof MatrixAnthropicConnectSchema>;
export type MatrixAnthropicDisconnect = z.infer<typeof MatrixAnthropicDisconnectSchema>;
export type MatrixAnthropicRefresh = z.infer<typeof MatrixAnthropicRefreshSchema>;
export type MatrixAnthropicSourceState = z.infer<typeof MatrixAnthropicSourceStateSchema>;

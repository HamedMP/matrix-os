import { z } from "zod/v4";

export const MATRIX_OPENAI_CONNECTION_ID = "matrix_openai_api" as const;
export const MatrixOpenAiCredentialGenerationSchema = z.uuid();
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ref = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const generation = MatrixOpenAiCredentialGenerationSchema.nullable();
const mutation = { expectedRevision: revision, expectedCredentialGeneration: generation, idempotencyKey: ref };

export const MatrixOpenAiConnectSchema = z.object({ ...mutation,
  apiKey: z.string().trim().min(8).max(4096).refine(value => !/[\r\n\0]/.test(value)),
}).strict();
export const MatrixOpenAiDisconnectSchema = z.object(mutation).strict();
export const MatrixOpenAiRefreshSchema = z.object(mutation).strict();
export const MatrixOpenAiSourceStateSchema = z.object({ version: z.literal(1), revision, enabled: z.boolean(), credentialGeneration: generation })
  .strict().refine(state => !state.enabled || state.credentialGeneration !== null, { message: "Enabled source requires an explicit credential generation" });

export const MatrixOpenAiConnectionSchema = z.object({
  connectionId: z.literal(MATRIX_OPENAI_CONNECTION_ID), providerId: z.literal("openai"),
  executionKind: z.literal("direct_pi"), billingKind: z.literal("api_key"),
  revision, enabled: z.boolean(), credentialGeneration: generation, sourceCredentialGeneration: generation,
  state: z.enum(["unsupported", "read_only", "disconnected", "auth_required", "refresh_required", "ready", "unavailable"]),
  models: z.array(z.object({ id: ref, displayName: z.string().min(1).max(120).regex(/^[^\u0000-\u001f\u007f]+$/), input: z.array(z.enum(["text", "image"])).min(1).max(2).refine(input => input.includes("text") && new Set(input).size === input.length).optional() }).strict()).max(256),
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

export type MatrixOpenAiConnection = z.infer<typeof MatrixOpenAiConnectionSchema>;
export type MatrixOpenAiConnect = z.infer<typeof MatrixOpenAiConnectSchema>;
export type MatrixOpenAiDisconnect = z.infer<typeof MatrixOpenAiDisconnectSchema>;
export type MatrixOpenAiRefresh = z.infer<typeof MatrixOpenAiRefreshSchema>;
export type MatrixOpenAiSourceState = z.infer<typeof MatrixOpenAiSourceStateSchema>;

export const MATRIX_PI_OPENAI_API_INSTANCE_ID = "matrix_pi_openai_api";
export const MATRIX_OPENAI_API_INSTANCE_ID = "matrix_openai_api";
export interface MatrixOpenAiBinding { connectionRevision: number; credentialGeneration: string }
export function matrixOpenAiSelectionBinding(options?: readonly { id: string; value: string | number | boolean }[]): (MatrixOpenAiBinding & { api: "openai-completions" | "openai-responses" }) | null {
  if (options?.length !== 3 || new Set(options.map(option => option.id)).size !== 3) return null;
  const revision = options.find(option => option.id === "connectionRevision")?.value;
  const generation = MatrixOpenAiCredentialGenerationSchema.safeParse(options.find(option => option.id === "credentialGeneration")?.value);
  const api = options.find(option => option.id === "api")?.value;
  if (typeof revision !== "string" || !/^[1-9][0-9]{0,15}$/.test(revision) || !Number.isSafeInteger(Number(revision)) || !generation.success
    || api !== "openai-completions" && api !== "openai-responses") return null;
  return { connectionRevision: Number(revision), credentialGeneration: generation.data, api };
}
export function sameMatrixOpenAiSelectionBinding(left?: readonly { id: string; value: string | number | boolean }[], right?: readonly { id: string; value: string | number | boolean }[]): boolean {
  const a = matrixOpenAiSelectionBinding(left), b = matrixOpenAiSelectionBinding(right);
  return !!a && !!b && a.connectionRevision === b.connectionRevision && a.credentialGeneration === b.credentialGeneration && a.api === b.api;
}

export function isMatrixOpenAiChatRoute(route: { instanceId: string; driverKind: string }): boolean {
  return route.instanceId === MATRIX_PI_OPENAI_API_INSTANCE_ID && route.driverKind === "matrix_pi";
}
export function isMatrixOpenAiBotRoute(route: { instanceId: string; driverKind: string }): boolean {
  return route.instanceId === MATRIX_OPENAI_API_INSTANCE_ID && route.driverKind === "matrix_bot";
}

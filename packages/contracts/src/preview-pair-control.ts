import { z } from "zod/v4";
import { PreviewPairActorSchema, PreviewPairDigestSchema, PreviewPairGenerationSchema, PreviewPairIdSchema,
  PreviewPairPrSchema, PreviewPairShaSchema, PreviewPairStateSchema } from "./preview-pair.js";
export const PreviewPairFailureStageSchema = z.enum(["authority", "membership", "owner_runtime", "member_runtime",
  "owner_control", "member_control", "owner_source", "member_source", "owner_funding", "member_funding",
  "cleanup_unconfirmed", "readiness_unavailable", "provisioning_unavailable", "activation_unavailable", "controller_unavailable", "publication_unavailable"]);
const Revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER), Timestamp = z.iso.datetime({ offset: true });
export const PreviewPairControlOriginSchema = z.enum(["https://app.matrix-os.com", "https://api.matrix-os.com"]);
const FailedStage = z.union([PreviewPairFailureStageSchema, z.literal("unavailable")]).nullable();
export const PreviewPairSetupSchema = z.strictObject({ controllerSha: PreviewPairShaSchema,
  controllerRef: z.string().max(96), requesterId: PreviewPairActorSchema, admissionEnabled: z.boolean() })
  .refine(value => value.controllerRef === `preview-pair-controller/${value.controllerSha}`, "Invalid controller reference");
export const PreviewPairControllerReceiptSchema = z.strictObject({ runId: Revision, pairId: PreviewPairIdSchema,
  pr: PreviewPairPrSchema, generation: PreviewPairGenerationSchema, sourceSha: PreviewPairShaSchema, requesterId: PreviewPairActorSchema });
export const PreviewPairSummarySchema = z.strictObject({ pairId: PreviewPairIdSchema, generation: PreviewPairGenerationSchema,
  revision: Revision, pr: PreviewPairPrSchema, sourceSha: PreviewPairShaSchema, state: PreviewPairStateSchema,
  outdated: z.boolean(), expiresAt: Timestamp, reportPath: z.string().regex(/^\/api\/preview-pairs\/[a-f0-9-]{36}$/) });
export const PreviewPairRequestReportSchema = z.strictObject({ kind: z.literal("request"), pairId: PreviewPairIdSchema,
  generation: PreviewPairGenerationSchema, revision: Revision, pr: PreviewPairPrSchema, sourceSha: PreviewPairShaSchema,
  state: z.enum(["prepared", "adopted", "cleanup_pending", "stopped"]), publication: z.enum(["unissued", "issuing", "accepted", "rejected"]),
  createdAt: Timestamp, expiresAt: Timestamp, infrastructureReady: z.literal(false), acceptance: z.literal("not_run"),
  members: z.array(z.never()).length(0), failedStage: FailedStage });
export const PreviewPairReportSelectionSchema = PreviewPairSummarySchema.omit({ reportPath: true }).strip();
export const PreviewPairAdmissionResultSchema = PreviewPairSummarySchema.extend({ ownedRequest: z.boolean() });
export const PreviewPairPreparedSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("request"), ownedRequest: z.literal(true), pairId: PreviewPairIdSchema,
    generation: PreviewPairGenerationSchema, state: z.enum(["prepared", "adopted"]), expiresAt: Timestamp,
    profileFingerprint: PreviewPairDigestSchema, buildContext: z.strictObject({
      identityIssuer: z.url().max(256), imageRepository: z.string().max(256).regex(/^[a-z0-9-]+-docker\.pkg\.dev\/[a-z0-9-]+\/[a-z0-9-]*preview[a-z0-9-]*\/matrix-platform$/),
      clerkPublishableKey: z.string().max(512).regex(/^pk_test_[A-Za-z0-9_=-]+$/) }) }),
  PreviewPairSummarySchema.extend({ kind: z.literal("pair"), ownedRequest: z.boolean() }),
]);
export const PreviewPairControllerStatusResultSchema = z.discriminatedUnion("kind", [PreviewPairRequestReportSchema,
  PreviewPairSummarySchema.extend({ kind: z.literal("pair"), currentGeneration: PreviewPairGenerationSchema,
    infrastructureReady: z.boolean(), acceptance: z.literal("not_run"), failedStage: FailedStage })]);
export type PreviewPairControllerReceipt = z.infer<typeof PreviewPairControllerReceiptSchema>;
export type PreviewPairSetup = z.infer<typeof PreviewPairSetupSchema>;

const GitHubRepo = z.object({ full_name: z.literal("HamedMP/matrix-os") });
export const PreviewPairPullSchema = z.object({ number: PreviewPairPrSchema, state: z.literal("open"),
  head: z.object({ sha: PreviewPairShaSchema, repo: GitHubRepo }), base: z.object({ repo: GitHubRepo }),
  labels: z.array(z.object({ name: z.string().max(128) })).max(128) });
export const PreviewPairWorkflowRunSchema = z.object({ id: Revision, head_sha: PreviewPairShaSchema,
  head_branch: z.string().max(128), display_title: z.string().max(256), path: z.string().max(256),
  event: z.literal("workflow_dispatch"), repository: GitHubRepo, head_repository: GitHubRepo,
  actor: z.object({ id: Revision }), triggering_actor: z.object({ id: Revision }),
  status: z.enum(["queued", "requested", "pending", "waiting", "in_progress", "completed"]),
  conclusion: z.string().max(32).nullable() });
export const PreviewPairWorkflowRunsSchema = z.object({ total_count: z.number().int().nonnegative().max(10_000),
  workflow_runs: z.array(PreviewPairWorkflowRunSchema).max(100) });
export const PreviewPairWorkflowRequestSchema = z.strictObject({ pairId: PreviewPairIdSchema,
  generation: PreviewPairGenerationSchema, pr: PreviewPairPrSchema, sourceSha: PreviewPairShaSchema,
  requesterId: PreviewPairActorSchema, action: z.enum(["create", "update"]), baseSourceSha: PreviewPairShaSchema.optional() })
  .refine(value => value.action === "create" ? value.generation === 1 && value.baseSourceSha === undefined
    : value.generation > 1 && value.baseSourceSha !== undefined, "Invalid pair action");
export type PreviewPairWorkflowRequest = z.infer<typeof PreviewPairWorkflowRequestSchema>;

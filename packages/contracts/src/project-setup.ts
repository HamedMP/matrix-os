import { z } from "zod/v4";
import { CanonicalChatIdSchema, CanonicalChatModelSelectionSchema, CanonicalChatRequestIdSchema } from "#canonical-chat";
import { CanonicalChatRecordSchema } from "#canonical-chat-api";
import { ProjectAgentConfigFileSchema, ProjectAgentContextNameSchema, PROJECT_SKILL_FILE_MAX_BYTES } from "#project-agent-context";
import { referenceId } from "#legacy-contract-primitives";

const answer = z.string().trim().min(1).max(4096);
const markdown = z.string().min(1).max(PROJECT_SKILL_FILE_MAX_BYTES)
  .refine(text => new TextEncoder().encode(text).byteLength <= PROJECT_SKILL_FILE_MAX_BYTES);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const ProjectSetupFileSchema = z.object({
  path: ProjectAgentConfigFileSchema,
  content: markdown.or(z.literal("")),
  status: z.enum(["pending", "saved", "already_present", "conflict", "failed"]),
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
}).strict().refine(file => file.content.length > 0
  || (["AGENTS.md", "CLAUDE.md"].includes(file.path) && file.status === "already_present"), {
  message: "Only a preserved existing instruction file may be empty",
});
export type ProjectSetupFile = z.infer<typeof ProjectSetupFileSchema>;

export const ProjectSetupDraftSchema = z.object({
  chatId: CanonicalChatIdSchema,
  projectId: referenceId(160),
  revision,
  step: z.enum(["guidance", "skill", "skill_instructions", "mcp", "review", "saved"]),
  currentQuestionMessageId: z.string().min(1).max(160),
  answers: z.object({ purpose: answer, guidance: answer.optional(), skillInstructions: answer.optional() }).strict(),
  skill: z.object({ name: ProjectAgentContextNameSchema, path: ProjectAgentConfigFileSchema, content: markdown }).strict().optional(),
  proposals: z.array(ProjectSetupFileSchema).max(3),
  mcp: z.object({ state: z.enum(["not_requested", "pending", "skipped"]), service: z.string().trim().min(1).max(80).optional() }).strict(),
  generation: z.object({ runId: z.string().max(160).optional(), sourceRevision: revision.optional(), status: z.enum(["pending", "running", "completed", "failed", "unavailable"]) }).strict().optional(),
  updatedAt: z.iso.datetime({ offset: true }),
}).strict();
export type ProjectSetupDraft = z.infer<typeof ProjectSetupDraftSchema>;

export const ProjectSetupActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("answer"), text: answer }).strict(),
  z.object({ type: z.literal("choose_skill"), choice: z.enum(["create", "skip"]) }).strict(),
  z.object({ type: z.literal("stage_skill"), content: markdown }).strict(),
  z.object({ type: z.literal("choose_mcp"), choice: z.enum(["connect", "skip"]), service: z.string().trim().min(1).max(80).optional() }).strict(),
  z.object({ type: z.literal("revise"), field: z.enum(["purpose", "guidance", "skillInstructions"]), text: answer }).strict(),
  z.object({ type: z.literal("review_file"), path: ProjectAgentConfigFileSchema, content: markdown }).strict(),
  z.object({ type: z.literal("prepare_review") }).strict(),
  z.object({ type: z.literal("generate"), selection: CanonicalChatModelSelectionSchema }).strict(),
  z.object({ type: z.literal("sync_generation") }).strict(),
  z.object({ type: z.literal("save") }).strict(),
]);
export type ProjectSetupAction = z.infer<typeof ProjectSetupActionSchema>;

export const ProjectSetupStartRequestSchema = z.object({
  clientRequestId: CanonicalChatRequestIdSchema,
  answer,
  currentSelection: CanonicalChatModelSelectionSchema.optional(),
}).strict();
export type ProjectSetupStartRequest = z.infer<typeof ProjectSetupStartRequestSchema>;

export const ProjectSetupUpdateRequestSchema = z.object({
  baseRevision: revision,
  clientRequestId: CanonicalChatRequestIdSchema,
  action: ProjectSetupActionSchema,
}).strict();
export type ProjectSetupUpdateRequest = z.infer<typeof ProjectSetupUpdateRequestSchema>;

export const ProjectSetupResponseSchema = z.object({
  draft: ProjectSetupDraftSchema.nullable(),
  record: CanonicalChatRecordSchema.optional(),
}).strict();
export type ProjectSetupResponse = z.infer<typeof ProjectSetupResponseSchema>;

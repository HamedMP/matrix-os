import { z } from "zod/v4";
import { CanonicalChatIdSchema, CanonicalChatModelSelectionSchema, CanonicalChatRequestIdSchema } from "#canonical-chat";
import { CanonicalChatRecordSchema } from "#canonical-chat-api";
import { ProjectAgentConfigFileSchema, ProjectAgentContextNameSchema, PROJECT_SKILL_FILE_MAX_BYTES } from "#project-agent-context";
import { referenceId } from "#legacy-contract-primitives";

const answer = z.string().trim().min(1).max(4096);
const markdown = z.string().min(1).max(PROJECT_SKILL_FILE_MAX_BYTES)
  .refine(text => new TextEncoder().encode(text).byteLength <= PROJECT_SKILL_FILE_MAX_BYTES);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const PROJECT_SETUP_PRIMARY_REPLY_LENGTH = 100;
export const PROJECT_SETUP_COMPACT_ANSWER_LENGTH = 32;
export const PROJECT_SETUP_MCP_NAME_MAX_LENGTH = 100;
const mcpServiceName = z.string().trim().min(1).max(PROJECT_SETUP_MCP_NAME_MAX_LENGTH);

export const ProjectSetupInterviewFocusSchema = z.enum(["intent", "guidance", "skill", "mcp", "review"]);
export const ProjectSetupInterviewSchema = z.object({
  focus: ProjectSetupInterviewFocusSchema,
  suggestions: z.array(z.string().trim().min(1).max(160)).max(3),
  recommendedService: mcpServiceName.optional(),
  mcpHandoff: z.literal(true).optional(),
}).strict();
export type ProjectSetupInterview = z.infer<typeof ProjectSetupInterviewSchema>;

export const ProjectSetupFileSchema = z.object({
  path: ProjectAgentConfigFileSchema,
  content: markdown.or(z.literal("")),
  status: z.enum(["pending", "saved", "already_present", "conflict", "failed", "symlink_skipped", "destination_unavailable"]),
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
  answers: z.object({ purpose: answer.or(z.literal("")), guidance: answer.optional(), skillInstructions: answer.optional() }).strict(),
  skill: z.object({
    name: ProjectAgentContextNameSchema,
    path: ProjectAgentConfigFileSchema,
    content: markdown,
    source: z.literal("user").optional(),
  }).strict().optional(),
  proposals: z.array(ProjectSetupFileSchema).max(3),
  mcp: z.object({ state: z.enum(["not_requested", "pending", "skipped"]), service: mcpServiceName.optional() }).strict(),
  generation: z.object({ runId: z.string().max(160).optional(), sourceRevision: revision.optional(), status: z.enum(["pending", "running", "completed", "failed", "unavailable"]) }).strict().optional(),
  interview: ProjectSetupInterviewSchema.optional(),
  updatedAt: z.iso.datetime({ offset: true }),
}).strict().refine(draft => Boolean(draft.interview || draft.answers.purpose));
export type ProjectSetupDraft = z.infer<typeof ProjectSetupDraftSchema>;

export const ProjectSetupActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("answer"), text: answer }).strict(),
  z.object({ type: z.literal("choose_skill"), choice: z.enum(["create", "skip"]) }).strict(),
  z.object({ type: z.literal("stage_skill"), content: markdown, selection: CanonicalChatModelSelectionSchema.optional() }).strict(),
  z.object({
    type: z.literal("choose_mcp"), choice: z.enum(["connect", "skip"]),
    service: mcpServiceName.optional(), selection: CanonicalChatModelSelectionSchema.optional(),
  }).strict(),
  z.object({ type: z.literal("revise"), field: z.enum(["purpose", "guidance", "skillInstructions"]), text: answer }).strict(),
  z.object({ type: z.literal("review_file"), path: ProjectAgentConfigFileSchema, content: markdown }).strict(),
  z.object({ type: z.literal("prepare_review") }).strict(),
  z.object({ type: z.literal("generate"), selection: CanonicalChatModelSelectionSchema }).strict(),
  z.object({ type: z.literal("interview_answer"), text: answer, selection: CanonicalChatModelSelectionSchema.optional() }).strict(),
  z.object({ type: z.literal("interview_retry"), selection: CanonicalChatModelSelectionSchema }).strict(),
  z.object({ type: z.literal("sync_generation") }).strict(),
  z.object({ type: z.literal("save") }).strict(),
]);
export type ProjectSetupAction = z.infer<typeof ProjectSetupActionSchema>;

const startFields = { clientRequestId: CanonicalChatRequestIdSchema, currentSelection: CanonicalChatModelSelectionSchema.optional() };
export const ProjectSetupStartRequestSchema = z.union([
  z.object({ ...startFields, answer }).strict(),
  z.object({ ...startFields, mode: z.literal("interview") }).strict(),
]);
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

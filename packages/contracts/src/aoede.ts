import { z } from "zod/v4";
import { CanonicalChatIdSchema, CanonicalChatModelSelectionSchema, CanonicalChatRequestIdSchema } from "#canonical-chat";
import { CanonicalCreateChatRequestSchema } from "#canonical-chat-api";
import { VoiceCapabilitySchema } from "#voice-session";

export const AoedeBootstrapRequestSchema = z.object({
  clientRequestId: CanonicalChatRequestIdSchema,
  intent: z.enum(["continue", "new"]),
  projectId: CanonicalCreateChatRequestSchema.shape.projectId,
  surface: z.enum(["web_canvas", "web_desktop"]),
}).strict();

export const AoedeScopeSchema = z.object({
  kind: z.enum(["workspace", "project"]),
  id: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
  label: z.string().trim().min(1).max(160),
}).strict();

export const AoedeBootstrapResponseSchema = z.object({
  chatId: CanonicalChatIdSchema,
  scope: AoedeScopeSchema,
  selection: CanonicalChatModelSelectionSchema,
  capability: VoiceCapabilitySchema,
}).strict();

export type AoedeBootstrapRequest = z.infer<typeof AoedeBootstrapRequestSchema>;
export type AoedeBootstrapResponse = z.infer<typeof AoedeBootstrapResponseSchema>;
export type AoedeScope = z.infer<typeof AoedeScopeSchema>;

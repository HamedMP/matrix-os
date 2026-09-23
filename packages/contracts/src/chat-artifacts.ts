import { z } from "zod/v4";
import {
  CanonicalChatRunIdSchema,
} from "#canonical-chat";
import {
  canonicalBoundedText,
  canonicalReferenceId,
} from "#canonical-chat-primitives";

const ProviderArtifactMimeTypeSchema = z.string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+/-]*(?:;[\x20-\x7e]+)?$/);
const ProviderArtifactLabelSchema = canonicalBoundedText(280, 1_120)
  .refine((value) => !/[\\/\u0000\r\n]/.test(value), "Artifact label must be a file name");

export const ChatArtifactProviderSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("run_file"),
    path: z.string()
      .min(1)
      .max(4_096)
      .startsWith("/")
      .refine((value) => !value.includes("\0") && !/[\r\n]/.test(value)),
  }).strict(),
  z.object({
    type: z.literal("inline_bytes"),
    mimeType: ProviderArtifactMimeTypeSchema,
    base64: z.string().min(1).max(12 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  }).strict(),
]);

export const ChatArtifactProviderEventSchema = z.object({
  providerItemId: canonicalReferenceId(128),
  runId: CanonicalChatRunIdSchema,
  source: ChatArtifactProviderSourceSchema,
  label: ProviderArtifactLabelSchema,
  mimeType: ProviderArtifactMimeTypeSchema.optional(),
}).strict();

export type ChatArtifactProviderSource = z.infer<typeof ChatArtifactProviderSourceSchema>;
export type ChatArtifactProviderEvent = z.infer<typeof ChatArtifactProviderEventSchema>;

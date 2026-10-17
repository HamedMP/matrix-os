import { canonicalBoundedText } from "#canonical-chat-primitives";
import { isAllowedCommandPreview, MAX_COMMAND_PREVIEW_CHARS, MAX_COMMAND_PREVIEW_BYTES } from "./command-preview-policy.mjs";

/** Bounded owner command contents; labels/errors retain their strict contracts. */
export const CanonicalChatCommandPreviewSchema = canonicalBoundedText(MAX_COMMAND_PREVIEW_CHARS, MAX_COMMAND_PREVIEW_BYTES)
  .refine(isAllowedCommandPreview, { message: "Invalid or credential-bearing command preview" });

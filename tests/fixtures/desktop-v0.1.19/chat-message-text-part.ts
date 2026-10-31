import { z } from "zod/v4";
// Released desktop-v0.1.19 / 28a5b2983ef57d7d4133c9b1fe1b6e4400df7af5:
// canonical-chat.ts text arm + canonical-chat-primitives.ts canonicalBoundedText.
// Explicit .length preserves the pinned Zod4.4.3 UTF16 .max semantics when
// this fixture is executed with newer Zod releases that count code points.
export const ReleasedChatTextPartSchema = z.object({
  type: z.literal("text"),
  text: z.string().min(1).max(32_000)
    .refine(value => value.length <= 32_000)
    .refine(value => value.trim().length > 0, { message: "Text cannot be blank" })
    .refine(value => new TextEncoder().encode(value).byteLength <= 96 * 1024, { message: "Text exceeds byte limit" }),
}).strict();

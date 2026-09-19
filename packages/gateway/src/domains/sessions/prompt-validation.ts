import { z } from "zod/v4";

export const DANGEROUS_CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
export const DANGEROUS_CONTROL_CHARS_GLOBAL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
export const MAX_PROMPT_CONTENT_LENGTH = 100_000;

export const PromptContentSchema = z.string().max(MAX_PROMPT_CONTENT_LENGTH).refine(
  (s) => !DANGEROUS_CONTROL_CHARS.test(s),
  "Prompt contains invalid control characters",
);

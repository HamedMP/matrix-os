import { z } from "zod/v4";

export const DANGEROUS_CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
export const DANGEROUS_CONTROL_CHARS_GLOBAL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export const PromptContentSchema = z.string().max(100_000).refine(
  (s) => !DANGEROUS_CONTROL_CHARS.test(s),
  "Prompt contains invalid control characters",
);

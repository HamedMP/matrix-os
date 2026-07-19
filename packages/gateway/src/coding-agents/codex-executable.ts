import { isAbsolute, join } from "node:path";
import { z } from "zod/v4";

export const CodexExecutableSchema = z.string()
  .trim()
  .min(1)
  .max(4096)
  .refine(isAbsolute)
  .regex(/^[^\u0000\r\n]+$/);

const CodexEnvironmentSchema = z.object({
  MATRIX_NODE_PREFIX: z.string().trim().min(1).max(4096).optional(),
}).passthrough();

export function codexExecutableFromEnv(
  environment: Record<string, string | undefined>,
): string {
  const parsed = CodexEnvironmentSchema.parse(environment);
  const prefix = parsed.MATRIX_NODE_PREFIX ?? "/opt/matrix/runtime/node";
  if (!isAbsolute(prefix) || /[\u0000\r\n]/.test(prefix)) {
    throw new Error("Codex executable configuration is invalid");
  }
  return CodexExecutableSchema.parse(join(prefix, "bin", "codex"));
}

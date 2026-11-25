import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
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

const DEFAULT_NODE_PREFIX = "/opt/matrix/runtime/node";
const CHAT_SELECTOR = "matrix-codex-chat";
const DEFAULT_CHAT_SELECTOR = `/opt/matrix/bin/${CHAT_SELECTOR}`;

export function codexExecutableFromEnv(
  environment: Record<string, string | undefined>,
  fileExists = existsSync,
): string {
  const parsed = CodexEnvironmentSchema.parse(environment);
  const prefix = parsed.MATRIX_NODE_PREFIX ?? DEFAULT_NODE_PREFIX;
  if (!isAbsolute(prefix) || /[\u0000\r\n]/.test(prefix)) {
    throw new Error("Codex executable configuration is invalid");
  }
  return CodexExecutableSchema.parse(prefix === DEFAULT_NODE_PREFIX && fileExists(DEFAULT_CHAT_SELECTOR)
    ? DEFAULT_CHAT_SELECTOR
    : join(prefix, "bin", "codex"));
}

export function codexExecutableDependencies(executable: string, nodePrefix = DEFAULT_NODE_PREFIX): string[] {
  if (!isAbsolute(executable) || basename(executable) !== CHAT_SELECTOR) return [];
  return [join(dirname(executable), "matrix-codex"), join(nodePrefix, "bin", "codex")];
}

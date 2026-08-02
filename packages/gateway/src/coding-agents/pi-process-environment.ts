import { delimiter, isAbsolute, join } from "node:path";
import { z } from "zod/v4";

// Pi runs provider-authenticated code and its read tool can inspect arbitrary
// readable files. Give it only the process metadata needed to find its binary,
// owner-local config/session files, locale, temp space, and outbound proxy.
// Gateway/database/platform credentials must never enter the child process.
const PI_ENV_ALLOWLIST = new Set([
  "HOME", "PATH", "SHELL", "USER", "LOGNAME",
  "TMPDIR", "TMP", "TEMP",
  "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "MATRIX_NODE_PREFIX",
]);

const MatrixNodePrefixSchema = z.string().trim().min(1).max(400)
  .refine((value) => isAbsolute(value) && !value.includes("\0"));

export function buildPiChildEnvironment(overrides: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PI_ENV_ALLOWLIST) {
    const value = overrides?.[key] ?? process.env[key];
    if (typeof value === "string") env[key] = value;
  }
  const prefix = MatrixNodePrefixSchema.safeParse(env.MATRIX_NODE_PREFIX);
  if (prefix.success) {
    const prefixBin = join(prefix.data, "bin");
    const pathEntries = (env.PATH ?? "").split(delimiter).filter(Boolean);
    env.PATH = [prefixBin, ...pathEntries.filter((entry) => entry !== prefixBin)].join(delimiter);
  }
  return env;
}

export function resolvePiCommand(
  explicit: string | undefined,
  env: Record<string, string> | undefined,
): string {
  if (explicit) return explicit;
  const prefix = MatrixNodePrefixSchema.safeParse(env?.MATRIX_NODE_PREFIX ?? process.env.MATRIX_NODE_PREFIX);
  return prefix.success ? join(prefix.data, "bin", "pi") : "pi";
}

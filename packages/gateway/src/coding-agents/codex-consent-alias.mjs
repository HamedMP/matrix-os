import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";

// ENG-523: consent saved before durable generations names exact token bytes.
// When the same, still-current credential is re-verified, the gateway records
// that this saved generation is the same account as its durable generation.
// The saved row is left untouched so its configuration fingerprint, existing
// session bindings and live runners keep the same identity.
export const CODEX_CONSENT_ALIAS_PATH = "system/ai-providers/codex-consent-alias.json";
const Hex = z.string().regex(/^[a-f0-9]{64}$/);
export const CodexConsentAliasSchema = z.object({ version: z.literal(1), saved: Hex, durable: Hex }).strict();
const MAX_BYTES = 1024;

/** Missing is "no alias"; any unsafe or malformed file is also no alias (fail closed). */
export async function readCodexConsentAlias(homePath) {
  let file;
  try { file = await open(join(homePath, CODEX_CONSENT_ALIAS_PATH), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (error?.code !== "ENOENT") console.warn("[native-codex] Consent alias unavailable:", error?.code ?? "UnknownError");
    return null;
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_BYTES) return null;
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_BYTES) return null;
    const parsed = CodexConsentAliasSchema.safeParse(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    console.warn("[native-codex] Consent alias unreadable:", error instanceof Error ? error.name : "UnknownError");
    return null;
  } finally { await file.close(); }
}

/** Saved consent matches the current durable generation directly or through its recorded alias. */
export function savedCodexConsentMatches(saved, current, alias) {
  if (!saved || !current) return false;
  return saved === current || Boolean(alias && alias.saved === saved && alias.durable === current);
}

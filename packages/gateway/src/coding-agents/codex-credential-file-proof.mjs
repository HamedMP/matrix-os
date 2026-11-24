import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { z } from "zod/v4";

const MAX_BYTES = 256 * 1024;
const ChatgptAuthSchema = z.object({ auth_mode: z.literal("chatgpt").optional(), tokens: z.object({
  access_token: z.string().min(1).max(64 * 1024),
  refresh_token: z.string().min(1).max(64 * 1024),
  account_id: z.string().min(1).max(256).optional(),
}) });

const ApiKeyAuthSchema = z.object({
  auth_mode: z.literal("apikey").optional(),
  OPENAI_API_KEY: z.string().min(8).max(4096).refine(value => value.trim().length > 0),
  tokens: z.null().optional(),
});

/** Durable consent names the signed-in account, never the rotating token bytes:
 * Codex rewrites auth.json on every token refresh. Null when the file carries no
 * stable account identity; callers then keep the exact credential generation. */
function credentialIdentity(canonical, credential) {
  const subject = credential.tokens?.account_id ? `chatgpt\0${credential.tokens.account_id}`
    : typeof credential.OPENAI_API_KEY === "string" && !credential.tokens ? `apikey\0${credential.OPENAI_API_KEY}` : null;
  return subject === null ? null
    : createHash("sha256").update("matrix-native-codex-identity-v1\0").update(canonical).update("\0").update(subject).digest("hex");
}

/** Durable, nonsecret generation source shared by Settings consent and native execution. */
export function codexNativeGenerationSource({ principal, credentialProof, credentialIdentity }) {
  if (credentialProof && !credentialIdentity) return JSON.stringify({ principal, credentialProof });
  const stable = principal.type === "chatgpt"
    ? { type: principal.type, email: principal.email, ...(principal.id ? { id: principal.id } : {}) } : { type: principal.type };
  return JSON.stringify({ principal: stable, ...(credentialIdentity ? { credentialIdentity } : {}) });
}

/** Private equality evidence only; bind solely after effective file-backend confirmation.
 * API-key proof is opt-in for native account lifecycle, never subscription execution. */
export function createCodexCredentialFileProofReader(input) {
  const read = createCodexCredentialFileEvidenceReader(input);
  return async () => (await read())?.proof ?? null;
}

/** One atomic read: `proof` binds the exact bytes, `identity` the signed-in account. */
export function createCodexCredentialFileEvidenceReader(input) {
  const selected = resolve(input.homePath, input.codexHome ?? ".codex");
  const AuthSchema = input.allowApiKey === true ? z.union([ChatgptAuthSchema, ApiKeyAuthSchema]) : ChatgptAuthSchema;
  return async () => {
    try {
      const uid = process.getuid?.();
      if (uid === undefined) return null;
      const canonical = await realpath(selected);
      for (const start of [selected, canonical]) {
        for (let ancestor = start; ; ancestor = dirname(ancestor)) {
          const info = await lstat(ancestor);
          const stickyRoot = info.uid === 0 && (info.mode & 0o1000) !== 0;
          if ((!info.isDirectory() && !info.isSymbolicLink()) || ![0, uid].includes(info.uid)
            || !info.isSymbolicLink() && (info.mode & 0o022) !== 0 && !stickyRoot) return null;
          if ((ancestor === selected || ancestor === canonical) && (info.uid !== uid || info.isSymbolicLink())) return null;
          if (dirname(ancestor) === ancestor) break;
        }
      }
      const path = join(canonical, "auth.json");
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || before.uid !== uid || (before.mode & 0o077) !== 0) return null;
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.uid !== uid || info.size < 2 || info.size > MAX_BYTES
          || info.ino !== before.ino || info.dev !== before.dev) return null;
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead > MAX_BYTES || bytesRead !== info.size) return null;
        const parsed = AuthSchema.safeParse(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")));
        if (!parsed.success) return null;
        const after = await file.stat();
        const current = await lstat(path);
        if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs
          || current.ino !== info.ino || current.dev !== info.dev || current.isSymbolicLink()
          || await realpath(selected) !== canonical) return null;
        return {
          proof: createHash("sha256").update("matrix-native-codex-credential-v1\0").update(canonical).update("\0").update(bytes.subarray(0, bytesRead)).digest("hex"),
          identity: credentialIdentity(canonical, parsed.data),
        };
      } finally { bytes.fill(0); await file.close(); }
    } catch (error) {
      if (!(error instanceof SyntaxError) && error?.code !== "ENOENT") {
        console.warn("[provider-settings] Codex credential proof unavailable:", error instanceof Error ? error.name : "UnknownError");
      }
      return null;
    }
  };
}

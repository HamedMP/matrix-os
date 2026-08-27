import { z } from "zod/v4";

const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const UNSAFE_CLIENT_LABEL =
  /postgres(?:ql)?:\/\/|\/home\/|\/tmp\/|\/var\/|\/opt\/|\/etc\/|\/root\/|\/Users\/|[A-Za-z]:[\\/]|\.ssh\/|id_rsa|(?:set-)?cookie\s*:|authorization\s*:\s*(?:basic|bearer)|bearer\s+|sk-[A-Za-z0-9_-]+|(?:aws_)?secret(?:_access_key)?\s*[=:]|api[_ -]?key\s*[=:]|client[_ -]?secret\s*[=:]|access[_ -]?token\s*[=:]|session[_ -]?(?:id|token|credential)\s*[=:]|credential\s*[=:]|password\s*[=:]|token\s*[=:]/i;
const UNSAFE_CLIENT_ERROR =
  /postgres|sqlite|mysql|openai|anthropic|twilio|pipedream|constraint|stack trace|zod|\/home\/|\/tmp\/|\/var\/|\/opt\/|\/etc\/|\/root\/|\/Users\/|[A-Za-z]:[\\/]|\.ssh\/|id_rsa|-----BEGIN (?:OPENSSH |RSA |EC |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----|(?:set-)?cookie\s*:|bearer\s+|authorization\s*[=:]\s*(?:basic|bearer)|\bbasic\s+[A-Za-z0-9+/=]{8,}|(?:aws_)?secret(?:_access_key)?\s*[=:]|api[_-]?key\s*[=:]|client[_-]?secret\s*[=:]|access[_-]?token\s*[=:]|credential\s*[=:]|session(?:id|_id|token|_token)?\s*[=:]|password\s*[=:]|token\s*[=:]|ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk_(?:live|test)_[A-Za-z0-9]{12,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]+/i;
const textEncoder = new TextEncoder();

export function canonicalReferenceId(max = 160) {
  return z.string()
    .min(1)
    .max(max)
    .regex(SAFE_REFERENCE, "Invalid reference identifier")
    .refine((value) => !value.includes(".."), {
      message: "Reference cannot contain traversal",
    });
}

export function canonicalBoundedText(maxChars: number, maxBytes: number) {
  return z.string()
    .min(1)
    .max(maxChars)
    .refine((value) => value.trim().length > 0, { message: "Text cannot be blank" })
    .refine((value) => textEncoder.encode(value).byteLength <= maxBytes, {
      message: "Text exceeds byte limit",
    });
}

export function canonicalSafeLabel(maxChars: number, maxBytes: number) {
  return canonicalBoundedText(maxChars, maxBytes).refine(
    (value) => !UNSAFE_CLIENT_LABEL.test(value),
    { message: "Text is not safe for clients" },
  );
}

export function canonicalSafeErrorText(maxChars: number, maxBytes: number) {
  return canonicalBoundedText(maxChars, maxBytes).refine(
    (value) => !UNSAFE_CLIENT_ERROR.test(value),
    { message: "Error text is not safe for clients" },
  );
}

export function canonicalEncodedByteLength(value: unknown): number {
  return textEncoder.encode(JSON.stringify(value)).byteLength;
}

export const CanonicalProviderDriverKindSchema = z.enum([
  "hermes",
  "openclaw",
  "codex",
  "claude_code",
  "opencode",
  "pi",
]);

export const CanonicalChatExecutionRootRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("project"),
    projectId: canonicalReferenceId(160),
  }).strict(),
  z.object({
    kind: z.literal("worktree"),
    projectId: canonicalReferenceId(160),
    worktreeId: canonicalReferenceId(128),
  }).strict(),
]);

export type CanonicalProviderDriverKind = z.infer<typeof CanonicalProviderDriverKindSchema>;
export type CanonicalChatExecutionRootRef = z.infer<typeof CanonicalChatExecutionRootRefSchema>;

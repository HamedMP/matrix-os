import { createHash } from "node:crypto";
import type { CodexNativeAccountMetadata } from "./codex-native-account-metadata.js";

/** Server-only foreground proof; never part of a public mutation or DTO. */
export type NativeAccountCompletionProof = (current: CodexNativeAccountMetadata) => Promise<boolean>;

// Observation lifetime only. Neither principal evidence nor verification functions
// are part of the public metadata object, persistence, contracts, or logs.
// `principal` is exact observation evidence; `generation` is the durable account
// identity persisted as consent when it differs (ENG-523: token refresh).
const bindings = new WeakMap<CodexNativeAccountMetadata, { verify: () => Promise<boolean>; principal?: string; generation?: string; credentialIdentityBound: boolean }>();
export function bindNativeAccountMetadata(value: CodexNativeAccountMetadata, verifyCurrent: () => Promise<boolean>, principal?: string, options: { credentialIdentityBound?: boolean; generation?: string } = {}): CodexNativeAccountMetadata {
  bindings.set(value, { verify: verifyCurrent, ...(principal ? { principal } : {}),
    ...(principal && options.generation ? { generation: options.generation } : {}),
    credentialIdentityBound: Boolean(principal && options.credentialIdentityBound) });
  return value;
}
/** An API-key type alone cannot identify which credential a destructive action targets. */
export function hasNativeAccountCredentialIdentity(value: CodexNativeAccountMetadata | null | undefined): boolean {
  return Boolean(value && bindings.get(value)?.credentialIdentityBound);
}
export async function verifyNativeAccountMetadata<T extends CodexNativeAccountMetadata>(value: T | null | undefined): Promise<T | null> {
  if (!value) return null;
  const verify = bindings.get(value)?.verify;
  if (!verify) return null;
  let timer: NodeJS.Timeout | undefined;
  try {
    const current = await Promise.race([verify(), new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), 8000);
      timer.unref();
    })]);
    return current ? value : null;
  }
  catch (error: unknown) {
    console.warn("[provider-settings] Native principal verification unavailable:", error instanceof Error ? error.name : "UnknownError");
    return null;
  } finally { clearTimeout(timer); }
}

/** Server-only equality of bound native principals; public labels cannot supply this proof. */
export function sameBoundNativeAccountPrincipal(left: CodexNativeAccountMetadata, right: CodexNativeAccountMetadata): boolean {
  const principal = bindings.get(left)?.principal;
  return principal !== undefined && principal === bindings.get(right)?.principal;
}

/** Nonsecret generation reference. Fresh verification remains mandatory before use. */
export function nativeAccountPrincipalFingerprint(value: CodexNativeAccountMetadata): string | null {
  const binding = bindings.get(value);
  const generation = binding?.generation ?? binding?.principal;
  return generation ? createHash("sha256").update(generation).digest("hex") : null;
}

/** Consent saved before durable generations named exact credential bytes. Only an
 * upgrade of that same still-current credential may use this; never authority. */
export function nativeAccountLegacyPrincipalFingerprint(value: CodexNativeAccountMetadata): string | null {
  const binding = bindings.get(value);
  return binding?.principal && binding.generation && binding.generation !== binding.principal
    ? createHash("sha256").update(binding.principal).digest("hex") : null;
}

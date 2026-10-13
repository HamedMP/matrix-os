import type { CodexNativeAccountMetadata } from "./codex-native-account-metadata.js";

// Observation lifetime only. Neither principal evidence nor verification functions
// are part of the public metadata object, persistence, contracts, or logs.
const bindings = new WeakMap<CodexNativeAccountMetadata, { verify: () => Promise<boolean>; principal?: string }>();
// Native workspace discovery alone can take 15s; include process startup margin.
export const NATIVE_ACCOUNT_OBSERVATION_TIMEOUT_MS = 20_000;
// File preflight and bounded child cleanup occur outside the observation timer.
export const NATIVE_ACCOUNT_VERIFICATION_TIMEOUT_MS = NATIVE_ACCOUNT_OBSERVATION_TIMEOUT_MS + 5_000;
export function bindNativeAccountMetadata(value: CodexNativeAccountMetadata, verifyCurrent: () => Promise<boolean>, principal?: string): CodexNativeAccountMetadata {
  bindings.set(value, { verify: verifyCurrent, ...(principal ? { principal } : {}) });
  return value;
}
export async function verifyNativeAccountMetadata<T extends CodexNativeAccountMetadata>(value: T | null | undefined): Promise<T | null> {
  if (!value) return null;
  const verify = bindings.get(value)?.verify;
  if (!verify) return null;
  let timer: NodeJS.Timeout | undefined;
  try {
    const current = await Promise.race([verify(), new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), NATIVE_ACCOUNT_VERIFICATION_TIMEOUT_MS);
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

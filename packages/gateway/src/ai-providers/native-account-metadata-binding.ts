import type { CodexNativeAccountMetadata } from "./codex-native-account-metadata.js";

// Observation lifetime only. Neither principal evidence nor verification functions
// are part of the public metadata object, persistence, contracts, or logs.
const bindings = new WeakMap<CodexNativeAccountMetadata, () => Promise<boolean>>();
export function bindNativeAccountMetadata(value: CodexNativeAccountMetadata, verifyCurrent: () => Promise<boolean>): CodexNativeAccountMetadata {
  bindings.set(value, verifyCurrent);
  return value;
}
export async function verifyNativeAccountMetadata(value: CodexNativeAccountMetadata | null | undefined): Promise<CodexNativeAccountMetadata | null> {
  if (!value) return null;
  const verify = bindings.get(value);
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

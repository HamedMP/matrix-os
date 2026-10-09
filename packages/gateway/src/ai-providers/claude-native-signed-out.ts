import { resolve } from "node:path";

/** Server-only authoritative absence; never serialized or inferred from null. */
export interface ClaudeNativeSignedOut { readonly state: "signed_out"; }
const bindings = new WeakMap<ClaudeNativeSignedOut, { home: string; verify: () => Promise<boolean> }>();
export function bindClaudeNativeSignedOut(home: string, now: () => Date, reobserve: () => Promise<boolean>): ClaudeNativeSignedOut {
  const observedAt = +now();
  const value: ClaudeNativeSignedOut = { state: "signed_out" };
  bindings.set(value, { home: resolve(home), verify: async () => {
    if (+now() < observedAt || +now() >= observedAt + 30_000) return false;
    return await reobserve() && +now() >= observedAt && +now() < observedAt + 30_000;
  } });
  return value;
}
export function isBoundClaudeNativeSignedOut(value: ClaudeNativeSignedOut | null | undefined, home?: string): boolean {
  const binding = value && bindings.get(value);
  return Boolean(binding && (home === undefined || binding.home === resolve(home)));
}
export async function verifyClaudeNativeSignedOut(value: ClaudeNativeSignedOut | null | undefined, home?: string): Promise<ClaudeNativeSignedOut | null> {
  if (!value || !isBoundClaudeNativeSignedOut(value, home)) return null;
  let timer: NodeJS.Timeout | undefined;
  try {
    const current = await Promise.race([bindings.get(value)!.verify(), new Promise<boolean>(accept => {
      timer = setTimeout(() => accept(false), 8000); timer.unref();
    })]);
    return current ? value : null;
  } catch (error: unknown) {
    console.warn("[provider-lifecycle] Native sign-out verification unavailable:", error instanceof Error ? error.name : "UnknownError");
    return null;
  } finally { clearTimeout(timer); }
}

/** Optional enrichment failure is unknown, including dependency-injected readers. */
export async function readVerifiedClaudeNativeSignedOut(read?: () => Promise<ClaudeNativeSignedOut | null>): Promise<ClaudeNativeSignedOut | null> {
  try { return await verifyClaudeNativeSignedOut(await read?.()); }
  catch (error: unknown) {
    console.warn("[provider-settings] Native sign-out reader unavailable:", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

import { createClaudeNativeAccountMetadataReader, type ClaudeNativeAccountMetadata } from "./claude-native-account-metadata.js";
import { sameBoundNativeAccountPrincipal, verifyNativeAccountMetadata } from "./native-account-metadata-binding.js";
import { NativeProviderWriteNotStartedError } from "./native-provider-profile-guard.js";

export type ClaudeAccountReaderUnderLease = () => Promise<ClaudeNativeAccountMetadata | null>;

/** Owned by the CLI lifecycle coordinator. Call only from its admitted durable writer. */
export function createClaudeAccountReaderUnderLease(homePath: string, environment: Record<string, string>): ClaudeAccountReaderUnderLease {
  return createClaudeNativeAccountMetadataReader({ executable: "claude", cwd: homePath, environment,
    // The coordinator holds this HOME's exclusive writer lease. The ordinary
    // metadata reader still rejects active writers, including this lease.
    assertProfileAvailable: async () => {},
  });
}

export async function assertClaudeLifecyclePrincipal(
  expected: ClaudeNativeAccountMetadata | undefined, readUnderLease: ClaudeAccountReaderUnderLease,
): Promise<void> {
  let current: ClaudeNativeAccountMetadata | null;
  try { current = await readUnderLease(); }
  catch (error) {
    console.warn("[provider-lifecycle] Native identity unavailable:", error instanceof Error ? error.name : "UnknownError");
    throw new NativeProviderWriteNotStartedError();
  }
  if (!expected || !current || !sameBoundNativeAccountPrincipal(expected, current)
    || !await verifyNativeAccountMetadata(current)) {
    throw new NativeProviderWriteNotStartedError();
  }
}

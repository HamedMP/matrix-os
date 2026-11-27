/** Bound owner capability and connection inventory reads without retaining a timer after settlement. */
const CAPABILITY_LOOKUP_TIMEOUT_MS = 10_000;
export async function withCapabilityLookupTimeout<T>(operation: () => Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("capability lookup timed out")), CAPABILITY_LOOKUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

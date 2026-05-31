export function createErrorId(error: Error & { digest?: string }): string {
  const suffix =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  if (error.digest) return `mx-${error.digest}-${suffix}`;
  const source = `${error.name}:${error.message}`;
  let hash = 5381;
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 33) ^ source.charCodeAt(i);
  }
  return `mx-${(hash >>> 0).toString(36)}-${suffix}`;
}

export function describeUnknownError(error: unknown): string {
  if (error instanceof globalThis.Error) return `${error.name}: ${error.message}`;
  try {
    return String(error);
  } catch (stringifyError) {
    void stringifyError;
    return typeof error;
  }
}

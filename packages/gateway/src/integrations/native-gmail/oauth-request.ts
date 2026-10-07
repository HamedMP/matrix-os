const ENDPOINTS = {
  token: "https://oauth2.googleapis.com/token",
  profile: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
  revoke: "https://oauth2.googleapis.com/revoke",
} as const;
const LIMIT = 65_536;
export class NativeGmailOAuthError extends Error {
  constructor(readonly invalidGrant = false) { super("Gmail connection unavailable"); }
}

/** A deadline covers fetch and every stream read, including injected fetchers. */
async function boundedAwait<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const abort = new Promise<never>((_, reject) => {
    onAbort = () => reject(new NativeGmailOAuthError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([pending, abort]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

export async function gmailOAuthRequest(options: {
  endpoint: keyof typeof ENDPOINTS; fetcher: typeof fetch; body?: URLSearchParams;
  accessToken?: string; signal?: AbortSignal;
}): Promise<{ status: number; body: string }> {
  const signal = options.signal ? AbortSignal.any([AbortSignal.timeout(10_000), options.signal]) : AbortSignal.timeout(10_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await boundedAwait(options.fetcher(ENDPOINTS[options.endpoint], {
      method: options.body ? "POST" : "GET", redirect: "error", signal,
      headers: options.body ? { "Content-Type": "application/x-www-form-urlencoded" }
        : { Authorization: `Bearer ${options.accessToken}` },
      ...(options.body ? { body: options.body.toString() } : {}),
    }), signal);
    if (response.status >= 300 && response.status < 400) throw new NativeGmailOAuthError();
    const length = response.headers.get("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > LIMIT)) throw new NativeGmailOAuthError();
    reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader) for (;;) {
      const result = await boundedAwait(reader.read(), signal);
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > LIMIT) throw new NativeGmailOAuthError();
      chunks.push(result.value);
    }
    return { status: response.status, body: Buffer.concat(chunks, bytes).toString("utf8") };
  } catch (error) {
    if (reader) void reader.cancel().catch((cancelError: unknown) => {
      // Cancellation is best-effort after the bounded operation has already failed.
      if (cancelError instanceof Error) console.warn("[gmail-oauth] Response cancellation failed");
    });
    if (error instanceof NativeGmailOAuthError) throw error;
    throw new NativeGmailOAuthError();
  } finally { reader?.releaseLock(); }
}

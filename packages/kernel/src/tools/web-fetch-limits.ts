export const MAX_WEB_RESPONSE_BYTES = 5 * 1024 * 1024;
export const MAX_WEB_FETCH_TIMEOUT_MS = 30_000;

export class WebFetchLimitError extends Error {}

export function boundedWebFetchLimit(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`Web fetch limit must be a positive integer at most ${maximum}`);
  }
  return value;
}

export function cancelWebBody(body: ReadableStream<Uint8Array> | null): void {
  if (body) {
    void body.cancel().catch((error: unknown) => {
      console.warn("[web-fetch] Response cancellation failed:", error);
    });
  }
}

/** One wall-clock budget for validation, all network hops and body reads. */
export class WebFetchBudget {
  readonly signal: AbortSignal;
  private readonly expiresAt: number;

  constructor(timeoutMs: number) {
    this.expiresAt = performance.now() + timeoutMs;
    this.signal = AbortSignal.timeout(timeoutMs);
  }

  check(): void {
    if (this.signal.aborted || performance.now() >= this.expiresAt) {
      throw new WebFetchLimitError("Web fetch deadline exceeded");
    }
  }

  // Race independently of the injected operation's signal support. Every late
  // settlement remains handled; late fetch responses also need cancellation.
  wait<T>(operation: Promise<T>, onLate?: (value: T) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        this.signal.removeEventListener("abort", onAbort);
        reject(new WebFetchLimitError("Web fetch deadline exceeded"));
      };
      this.signal.addEventListener("abort", onAbort, { once: true });
      if (this.signal.aborted) onAbort();
      operation.then((value) => {
        this.signal.removeEventListener("abort", onAbort);
        try {
          this.check();
          resolve(value);
        } catch (error: unknown) {
          onLate?.(value);
          reject(error);
        }
      }, (error: unknown) => {
        this.signal.removeEventListener("abort", onAbort);
        reject(this.signal.aborted ? new WebFetchLimitError("Web fetch deadline exceeded") : error);
      });
    });
  }
}

/** Fetch exposes decoded bytes: Content-Length may describe compressed bytes. */
export async function readBoundedWebBody(
  body: ReadableStream<Uint8Array> | null,
  budget: WebFetchBudget,
  maxBytes: number,
): Promise<string> {
  if (body === null) {
    budget.check();
    return "";
  }
  if (!body || typeof body.getReader !== "function") {
    throw new Error("Web fetch requires a streaming response body");
  }
  const reader = body.getReader();
  // Retained memory is independent of the number or size of streamed chunks.
  const buffer = new Uint8Array(maxBytes);
  let receivedBytes = 0;
  let completed = false;
  try {
    while (true) {
      budget.check();
      const { done, value } = await budget.wait(reader.read());
      if (done) {
        completed = true;
        return new TextDecoder().decode(buffer.subarray(0, receivedBytes));
      }
      if (value.byteLength > maxBytes - receivedBytes) {
        throw new WebFetchLimitError("Web fetch response byte limit exceeded");
      }
      buffer.set(value, receivedBytes);
      receivedBytes += value.byteLength;
    }
  } finally {
    if (!completed) {
      // Cancellation hooks are not allowed to hold the caller past its deadline.
      void reader.cancel().catch((error: unknown) => {
        console.warn("[web-fetch] Response reader cancellation failed:", error);
      });
    }
    reader.releaseLock();
  }
}

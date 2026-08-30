import type { AdmissionLease } from "./funded-relay-admission.js";

export function safeUpstreamHeaders(upstream: Response): Headers {
  const headers = new Headers();
  const upstreamContentType = upstream.headers.get("content-type")?.toLowerCase() ?? "";
  headers.set(
    "content-type",
    upstreamContentType.startsWith("text/event-stream")
      ? "text/event-stream"
      : "application/json",
  );
  headers.set("cache-control", "no-store");
  return headers;
}

export function boundedBody(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
  lease: AdmissionLease,
  abortUpstream: (reason?: unknown) => void,
  lifetimeSignal: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let seen = 0;
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    lifetimeSignal.removeEventListener("abort", onLifetimeAbort);
    lease.release();
  };
  const onLifetimeAbort = (): void => {
    void reader.cancel("request lifetime ended").catch((error: unknown) => {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      console.warn("[proxy] Funded AI response cancellation failed", { errorName });
    });
    settle();
  };
  if (lifetimeSignal.aborted) {
    onLifetimeAbort();
  } else {
    lifetimeSignal.addEventListener("abort", onLifetimeAbort, { once: true });
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          settle();
          reader.releaseLock();
          controller.close();
          return;
        }
        seen += result.value.byteLength;
        if (seen > maxBytes) {
          abortUpstream("response limit exceeded");
          await reader.cancel("response limit exceeded");
          settle();
          controller.error(new Error("AI response exceeded the configured limit"));
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        settle();
        if (!lifetimeSignal.aborted) {
          const errorName = error instanceof Error ? error.name : "UnknownError";
          console.warn("[proxy] Funded AI response stream failed", { errorName });
        }
        controller.error(new Error("AI response stream failed"));
      }
    },
    async cancel(reason) {
      abortUpstream(reason);
      try {
        await reader.cancel(reason);
      } finally {
        settle();
      }
    },
  });
}

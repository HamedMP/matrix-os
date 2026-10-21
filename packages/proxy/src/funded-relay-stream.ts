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
  observer?: {
    push(chunk: Uint8Array): void;
    complete(): void;
    ambiguous(): void;
  },
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let seen = 0;
  let settled = false;
  let terminalReported = false;
  let cancelling = false;
  let cancellation: Promise<void> | undefined;
  const reportComplete = (): void => {
    if (terminalReported) return;
    terminalReported = true;
    observer?.complete();
  };
  const reportAmbiguous = (): void => {
    if (terminalReported) return;
    terminalReported = true;
    observer?.ambiguous();
  };
  const settle = (): void => {
    if (settled) return;
    settled = true;
    lifetimeSignal.removeEventListener("abort", onLifetimeAbort);
    lease.release();
  };
  const cancelSource = (reason?: unknown): Promise<void> => {
    cancelling = true;
    cancellation ??= reader.cancel(reason).then(reportAmbiguous).finally(settle);
    return cancellation;
  };
  const onLifetimeAbort = (): void => {
    void cancelSource("request lifetime ended").catch((error: unknown) => {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      console.warn("[proxy] Funded AI response cancellation failed", { errorName });
    });
  };
  if (lifetimeSignal.aborted) {
    onLifetimeAbort();
  } else {
    lifetimeSignal.addEventListener("abort", onLifetimeAbort, { once: true });
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let sourceFailed = false;
      try {
        const result = await reader.read().catch((error: unknown) => { sourceFailed = true; throw error; });
        if (result.done) {
          if (!cancelling) reportComplete();
          if (!cancelling) settle();
          reader.releaseLock();
          controller.close();
          return;
        }
        seen += result.value.byteLength;
        if (seen > maxBytes) {
          const ended = cancelSource("response limit exceeded");
          abortUpstream("response limit exceeded");
          await ended;
          settle();
          controller.error(new Error("AI response exceeded the configured limit"));
          return;
        }
        observer?.push(result.value);
        controller.enqueue(result.value);
      } catch (error) {
        if (sourceFailed && !cancelling) reportAmbiguous();
        else if (!cancelling) await cancelSource("response processing failed").catch((cancelError: unknown) => {
          console.warn("[proxy] Funded AI response cancellation failed", { errorName: cancelError instanceof Error ? cancelError.name : "UnknownError" });
        });
        settle();
        if (!lifetimeSignal.aborted) {
          const errorName = error instanceof Error ? error.name : "UnknownError";
          console.warn("[proxy] Funded AI response stream failed", { errorName });
        }
        controller.error(new Error("AI response stream failed"));
      }
    },
    async cancel(reason) {
      const ended = cancelSource(reason);
      abortUpstream(reason);
      try {
        await ended;
      } finally {
        settle();
      }
    },
  });
}

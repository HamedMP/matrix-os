import { withinIntegrationDeadline } from "../bounded-proxy-transport.js";

const MESSAGES = {
  consent_required: "Reconnect Outlook to continue",
  throttled: "Outlook is busy. Try again later",
  unavailable: "Outlook is unavailable",
} as const;

export class OutlookError extends Error {
  constructor(readonly code: keyof typeof MESSAGES, readonly retryAfter?: number) {
    super(MESSAGES[code]);
    this.name = "OutlookError";
  }
}

function cancel(body: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array> | null): void {
  void body?.cancel().catch((error: unknown) => console.warn("[outlook] Response cancellation failed", {
    errorName: error instanceof Error ? error.name : "UnknownError",
  }));
}

async function readJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (!response.body || (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes))) {
    cancel(response.body);
    throw new OutlookError("unavailable");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await withinIntegrationDeadline(() => reader.read(), signal);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes || chunks.length === 4096) throw new OutlookError("unavailable");
      chunks.push(chunk.value);
    }
    signal.throwIfAborted();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)));
  } catch (error: unknown) {
    cancel(reader);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export const GRAPH_ORIGIN = "https://graph.microsoft.com";
export const MICROSOFT_OAUTH = "https://login.microsoftonline.com/common/oauth2/v2.0";

export async function requestOutlookJson(options: {
  url: string;
  request: RequestInit;
  signal: AbortSignal;
  fetcher: typeof fetch;
  maxBytes: number;
  isConsentError?: (data: unknown) => boolean;
}): Promise<unknown> {
  try {
    const url = new URL(options.url);
    if (url.username || url.password || url.hash
      || (url.origin !== GRAPH_ORIGIN && url.href !== `${MICROSOFT_OAUTH}/token`)) {
      throw new OutlookError("unavailable");
    }
    const response = await withinIntegrationDeadline(() => options.fetcher(url.href, {
      ...options.request,
      redirect: "error",
      signal: options.signal,
    }), options.signal);
    if (response.status === 429) {
      cancel(response.body);
      const header = response.headers.get("Retry-After") ?? "";
      throw new OutlookError("throttled", /^\d{1,6}$/.test(header) ? Number(header) : undefined);
    }
    if (!response.ok) {
      if (response.status === 400 && options.isConsentError) {
        const data = await readJson(response, options.maxBytes, options.signal);
        if (options.isConsentError(data)) throw new OutlookError("consent_required");
      } else {
        cancel(response.body);
      }
      throw new OutlookError(response.status === 401 && url.origin === GRAPH_ORIGIN ? "consent_required" : "unavailable");
    }
    return await readJson(response, options.maxBytes, options.signal);
  } catch (error: unknown) {
    throw error instanceof OutlookError ? error : new OutlookError("unavailable");
  }
}

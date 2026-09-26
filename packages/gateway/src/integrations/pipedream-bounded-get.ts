import { z } from "zod/v4";
import { JevInboxGmailIdSchema } from "@matrix-os/contracts";

const Identity = {
  externalUserId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:@-]+$/),
  accountId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/),
};
const Id = JevInboxGmailIdSchema;
const Input = z.discriminatedUnion("kind", [
  z.strictObject({ ...Identity, kind: z.literal("profile") }),
  z.strictObject({ ...Identity, kind: z.literal("threads") }),
  z.strictObject({ ...Identity, kind: z.literal("thread-ids"), id: Id }),
  z.strictObject({ ...Identity, kind: z.literal("message"), id: Id }),
]);
export type BoundedGmailRead = z.infer<typeof Input>;

export class BoundedPipedreamReadError extends Error {
  constructor() { super("Integration read unavailable"); this.name = "BoundedPipedreamReadError"; }
}

function cancel(body: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array> | null): void {
  void body?.cancel().catch((error: unknown) => {
    console.warn("[integrations] Bounded body cancellation failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  });
}

/** The deadline also covers token resolution and streamed body reads. */
async function withinDeadline<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => undefined;
  try {
    const promise = Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); });
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new BoundedPipedreamReadError());
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    })]);
  } finally { signal.removeEventListener("abort", onAbort); }
}

/** Narrow raw REST seam inside the existing Pipedream OAuth/proxy path.
 * Never accepts an arbitrary URL, HTTP method, account mutation, or page token.
 * The token supplier belongs to the existing SDK client; this adds no auth store.
 */
export function createBoundedPipedreamGet(options: {
  projectId: string;
  environment: "development" | "production";
  getAccessToken: () => Promise<string>;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
}): (input: unknown, callerSignal?: AbortSignal) => Promise<unknown> {
  const projectId = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/).parse(options.projectId);
  const environment = z.enum(["development", "production"]).parse(options.environment);
  return async (rawInput, callerSignal) => {
    const input = Input.parse(rawInput);
    callerSignal?.throwIfAborted();
    const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000);
    const target = new URL("https://gmail.googleapis.com/gmail/v1/users/me/profile");
    let maxBytes = 32 * 1024;
    if (input.kind === "threads") {
      target.pathname = "/gmail/v1/users/me/threads";
      target.searchParams.set("labelIds", "INBOX");
      target.searchParams.set("maxResults", "30");
      target.searchParams.set("fields", "threads(id,snippet),nextPageToken");
    } else if (input.kind === "thread-ids") {
      maxBytes = 64 * 1024;
      target.pathname = `/gmail/v1/users/me/threads/${input.id}`;
      target.searchParams.set("format", "full");
      target.searchParams.set("fields", "id,historyId,messages(id,internalDate)");
    } else if (input.kind === "message") {
      maxBytes = 128 * 1024;
      target.pathname = `/gmail/v1/users/me/messages/${input.id}`;
      target.searchParams.set("format", "full");
      target.searchParams.set("fields", "id,threadId,internalDate,snippet,payload(mimeType,filename,headers,body,parts)");
    }
    const url = new URL(`https://api.pipedream.com/v1/connect/${projectId}/proxy/${Buffer.from(target.href).toString("base64url")}`);
    url.searchParams.set("external_user_id", input.externalUserId);
    url.searchParams.set("account_id", input.accountId);
    let response: Response;
    try {
      const token = await withinDeadline(() => options.getAccessToken(), signal);
      signal.throwIfAborted();
      response = await withinDeadline(() => (options.fetcher ?? fetch)(url.href, {
        method: "GET", redirect: "error", signal,
        headers: { Authorization: `Bearer ${token}`, "x-pd-environment": environment, Accept: "application/json" },
      }), signal);
    } catch (error: unknown) {
      console.warn("[integrations] Bounded request failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
      throw new BoundedPipedreamReadError();
    }
    const length = response.headers.get("content-length");
    if (!response.ok || !response.body || (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes))) {
      cancel(response.body); throw new BoundedPipedreamReadError();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const next = await withinDeadline(() => reader.read(), signal);
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > maxBytes || chunks.length >= 4096) throw new BoundedPipedreamReadError();
        chunks.push(next.value);
      }
      signal.throwIfAborted();
      const raw = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes);
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as unknown;
    } catch (error: unknown) {
      cancel(reader);
      console.warn("[integrations] Bounded read failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
      throw new BoundedPipedreamReadError();
    } finally { reader.releaseLock(); }
  };
}

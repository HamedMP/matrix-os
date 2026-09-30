import { z } from "zod/v4";
import { EMAIL_TRIAGE_LABELS, JevInboxGmailIdSchema } from "@matrix-os/contracts";
import { boundedOperation } from "../bounded-operation.js";

export const JevUserLabelId = z.string().max(160).regex(/^Label_[A-Za-z0-9_-]+$/);
export const JevCategoryLabel = z.enum(Object.values(EMAIL_TRIAGE_LABELS));
const Identity = { externalUserId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:@-]+$/),
  accountId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/) };
const Input = z.discriminatedUnion("kind", [
  z.strictObject({ ...Identity, kind: z.literal("labels") }),
  z.strictObject({ ...Identity, kind: z.literal("message-labels"), messageId: JevInboxGmailIdSchema }),
  z.strictObject({ ...Identity, kind: z.literal("create-label"), name: JevCategoryLabel }),
  z.strictObject({ ...Identity, kind: z.literal("add-labels"), messageId: JevInboxGmailIdSchema,
    labelIds: z.array(JevUserLabelId).min(1).max(8).refine(ids => new Set(ids).size === ids.length) }),
]);
export class JevLabelTransportError extends Error {
  constructor() { super("Mailbox labeling could not be confirmed"); this.name = "JevLabelTransportError"; }
}
function cancel(body: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array> | null): void {
  void body?.cancel().catch((error: unknown) => console.warn("[jev-labels] Body cleanup failed", {
    errorName: error instanceof Error ? error.name : "UnknownError" }));
}

/** Fixed OAuth proxy targets only. Never removes labels, retries writes, or accepts URLs/methods. */
export function createBoundedPipedreamLabels(options: {
  projectId: string; environment: "development" | "production"; getAccessToken: () => Promise<string>;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
}) {
  const project = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/).parse(options.projectId);
  const environment = z.enum(["development", "production"]).parse(options.environment);
  return async (raw: unknown, callerSignal?: AbortSignal): Promise<unknown> => {
    const input = Input.parse(raw);
    return boundedOperation(async signal => {
      const target = new URL("https://gmail.googleapis.com/gmail/v1/users/me/labels");
      let body: string | undefined;
      if (input.kind === "labels") target.searchParams.set("fields", "labels(id,name,type)");
      if (input.kind === "create-label") body = JSON.stringify({ name: input.name, labelListVisibility: "labelShow", messageListVisibility: "show" });
      if (input.kind === "message-labels" || input.kind === "add-labels") {
        target.pathname = `/gmail/v1/users/me/messages/${input.messageId}${input.kind === "add-labels" ? "/modify" : ""}`;
        target.searchParams.set("fields", "id,threadId,labelIds");
        if (input.kind === "message-labels") target.searchParams.set("format", "minimal");
        else body = JSON.stringify({ addLabelIds: input.labelIds });
      }
      const url = new URL(`https://api.pipedream.com/v1/connect/${project}/proxy/${Buffer.from(target.href).toString("base64url")}`);
      url.searchParams.set("external_user_id", input.externalUserId); url.searchParams.set("account_id", input.accountId);
      const token = await options.getAccessToken(); signal.throwIfAborted();
      const response = await (options.fetcher ?? fetch)(url.href, { method: body ? "POST" : "GET", body, signal,
        redirect: "error", headers: { Authorization: `Bearer ${token}`, "x-pd-environment": environment,
          Accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) } });
      const length = response.headers.get("content-length");
      const maxBytes = input.kind === "labels" ? 512 * 1024 : 32 * 1024;
      if (signal.aborted || !response.ok || !response.body || (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes))) {
        cancel(response.body); throw new JevLabelTransportError();
      }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      const aborted = () => cancel(reader); signal.addEventListener("abort", aborted, { once: true });
      try {
        for (;;) {
          signal.throwIfAborted(); const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > maxBytes || chunks.length >= 4096) throw new JevLabelTransportError();
          chunks.push(next.value);
        }
        signal.throwIfAborted();
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes))) as unknown;
      } catch (error) { cancel(reader); throw error; }
      finally { signal.removeEventListener("abort", aborted); reader.releaseLock(); }
    }, 10_000, callerSignal);
  };
}

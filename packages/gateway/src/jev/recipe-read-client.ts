import { z } from "zod/v4";
import { boundedOperation } from "../bounded-operation.js";
import { delegatedIntegrationHeaders } from "../integrations/delegated-identity.js";
import { INTEGRATION_READ_SCOPE_HEADER } from "../integrations/scope-provenance.js";
import { JevReadBindingSchema, executeJevBoundRead } from "../integrations/jev-bound-read.js";
import { resolveIntegrationConnection } from "../integrations/connection-selection.js";
import type { PlatformDb } from "../platform-db.js";
import type { PipedreamConnectClient } from "../integrations/pipedream.js";
import type { HermesJevScope } from "../chat/hermes-integration-capability.js";
import { GmailId } from "./inbox-evidence.js";
import { InboxPreviewError } from "./inbox-broker.js";
const Request = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("get_profile"), params: z.strictObject({}) }),
  z.strictObject({ action: z.literal("list_threads"), params: z.strictObject({}) }),
  z.strictObject({ action: z.literal("get_thread_ids"), params: z.strictObject({ threadId: GmailId }) }),
  z.strictObject({ action: z.literal("get_message"), params: z.strictObject({ messageId: GmailId }) }),
]);
const Envelope = z.object({ service: z.literal("gmail"), action: z.enum(["get_profile", "list_threads", "get_thread_ids", "get_message"]), data: z.unknown() });
const MAX_BYTES = 192 * 1024;
function cancel(body: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array> | null): void {
  void body?.cancel().catch((error: unknown) => console.warn("[jev] Read body cancellation failed", {
    errorName: error instanceof Error ? error.name : "UnknownError",
  }));
}
/** Reuses existing authenticated internal read-call, including signed owner delegation. */
export function createJevRecipeReadClient(options: {
  internalBaseUrl: string | null; machineToken?: string;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  db?: PlatformDb | null; pipedream?: PipedreamConnectClient | null;
}) {
  return async (ownerId: string, scope: HermesJevScope, action: string, params: Record<string, unknown> = {}, callerSignal?: AbortSignal): Promise<unknown> => {
    const input = Request.parse({ action, params });
    const binding = JevReadBindingSchema.parse(scope.account);
    callerSignal?.throwIfAborted();
    if (!options.internalBaseUrl) {
      if (!options.db || !options.pipedream) throw new InboxPreviewError("unavailable");
      return boundedOperation(async signal => {
        const selected = resolveIntegrationConnection(await options.db!.listConnectedServices(ownerId), "gmail", binding.accountLabel);
        if (selected.kind !== "found") throw new InboxPreviewError("denied");
        const user = await options.db!.getUserById(ownerId);
        signal.throwIfAborted();
        if (!user?.pipedream_external_id) throw new InboxPreviewError("unavailable");
        return executeJevBoundRead({ ownerId, externalUserId: user.pipedream_external_id, connection: selected.connection,
          binding, action: input.action, params: input.params, pipedream: options.pipedream!, signal });
      }, 15_000, callerSignal);
    }
    if (!options.machineToken) throw new InboxPreviewError("unavailable");
    const body = JSON.stringify({ service: "gmail", action: input.action, label: binding.accountLabel, params: input.params, binding });
    const headers = new Headers({ Authorization: `Bearer ${options.machineToken}`, "content-type": "application/json",
      [INTEGRATION_READ_SCOPE_HEADER]: "read", ...delegatedIntegrationHeaders(ownerId, options.machineToken) });
    return boundedOperation(async (signal) => {
      const response = await (options.fetcher ?? fetch)(`${options.internalBaseUrl!.replace(/\/$/, "")}/read-call`, {
        method: "POST", body, headers, redirect: "error", signal,
      });
      if (signal.aborted) { cancel(response.body); signal.throwIfAborted(); }
      const length = response.headers.get("content-length");
      if (!response.ok || !response.body || (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES))) {
        cancel(response.body); throw new InboxPreviewError(response.status === 403 ? "denied" : "unavailable");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      const onAbort = () => cancel(reader);
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        while (true) {
          signal.throwIfAborted();
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > MAX_BYTES || chunks.length >= 4096) throw new InboxPreviewError("unavailable");
          chunks.push(next.value);
        }
        signal.throwIfAborted();
        const envelope = Envelope.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))));
        if (envelope.action !== input.action) throw new InboxPreviewError("unavailable");
        return envelope.data;
      } catch (error) {
        cancel(reader);
        throw error;
      } finally { signal.removeEventListener("abort", onAbort); reader.releaseLock(); }
    }, 15_000, callerSignal);
  };
}

import type { PlatformDb } from "../platform-db.js";
import type { PipedreamConnectClient } from "../integrations/pipedream.js";
import type { HermesJevScope } from "../chat/hermes-integration-capability.js";
import { JevReadBindingSchema } from "../integrations/jev-bound-read.js";
import { JevLabelInput, JevLabelOperation, applyJevLabels, executeJevBoundLabels } from "../integrations/jev-bound-labels.js";
import { resolveIntegrationConnection } from "../integrations/connection-selection.js";
import { delegatedIntegrationHeaders } from "../integrations/delegated-identity.js";
import { boundedOperation } from "../bounded-operation.js";
import { z } from "zod/v4";
import { createJevRecipeReadClient } from "./recipe-read-client.js";

/** One exact transport, selected at composition time; never falls back after a failed write. */
export function createJevRecipeLabelClient(options: { internalBaseUrl: string | null; machineToken?: string;
  db?: PlatformDb | null; pipedream?: PipedreamConnectClient | null;
  fetcher?: (url: string, init: RequestInit) => Promise<Response> }) {
  const read = createJevRecipeReadClient(options);
  return async (ownerId: string, scope: HermesJevScope, raw: z.infer<typeof JevLabelInput>, parent: AbortSignal | undefined,
    authorize: () => Promise<void>) => {
    const input = JevLabelInput.parse(raw); const binding = JevReadBindingSchema.parse(scope.account);
    if (binding.labelingEnabled !== true) throw new Error("Labeling permission unavailable");
    return boundedOperation(async signal => {
      if (!options.internalBaseUrl) {
        if (!options.db || !options.pipedream) throw new Error("Labeling unavailable");
        const selected = resolveIntegrationConnection(await options.db.listConnectedServices(ownerId), "gmail", binding.accountLabel);
        if (selected.kind !== "found") throw new Error("Bound account unavailable");
        const user = await options.db.getUserById(ownerId);
        if (!user?.pipedream_external_id) throw new Error("Owner unavailable");
        signal.throwIfAborted();
        return executeJevBoundLabels({ ownerId, externalUserId: user.pipedream_external_id,
          connection: selected.connection, binding, input, pipedream: options.pipedream, signal, authorize });
      }
      if (!options.machineToken) throw new Error("Labeling unavailable");
      const internalBaseUrl = options.internalBaseUrl;
      const machineToken = options.machineToken;
      const call = async (operation: z.infer<typeof JevLabelOperation>): Promise<unknown> => boundedOperation(async requestSignal => {
        await authorize(); requestSignal.throwIfAborted();
        const response = await (options.fetcher ?? fetch)(`${internalBaseUrl.replace(/\/$/, "")}/jev-label-call`, {
          method: "POST", body: JSON.stringify({ binding, operation }), redirect: "error", signal: requestSignal,
          headers: { Authorization: `Bearer ${machineToken}`, "content-type": "application/json",
            ...delegatedIntegrationHeaders(ownerId, machineToken) } });
        const cancel = () => { void response.body?.cancel().catch((error: unknown) => console.warn("[jev-labels] Response cleanup failed", {
          errorName: error instanceof Error ? error.name : "UnknownError" })); };
        const length = response.headers.get("content-length");
        const maxBytes = operation.kind === "labels" ? 512 * 1024 : 32 * 1024;
        if (requestSignal.aborted || !response.ok || !response.body || (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes))) {
          cancel(); throw new Error("Labeling unconfirmed");
        }
        const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
        const aborted = () => { void reader.cancel().catch((error: unknown) => console.warn("[jev-labels] Read cleanup failed", {
          errorName: error instanceof Error ? error.name : "UnknownError" })); };
        requestSignal.addEventListener("abort", aborted, { once: true });
        try {
          for (;;) {
            requestSignal.throwIfAborted(); const next = await reader.read(); if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > maxBytes || chunks.length >= 4096) throw new Error("Labeling unconfirmed");
            chunks.push(next.value);
          }
          requestSignal.throwIfAborted();
          return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes))) as unknown;
        } catch (error) { aborted(); throw error; }
        finally { requestSignal.removeEventListener("abort", aborted); reader.releaseLock(); }
      }, 45_000, signal);
      return applyJevLabels({ input, signal, authorize, call,
        verify: async () => { await read(ownerId, scope, "get_profile", {}, signal); } });
    }, 300_000, parent);
  };
}

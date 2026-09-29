import type { PlatformDb } from "../platform-db.js";
import type { PipedreamConnectClient } from "../integrations/pipedream.js";
import type { HermesJevScope } from "../chat/hermes-integration-capability.js";
import { JevReadBindingSchema } from "../integrations/jev-bound-read.js";
import { JevLabelInput, JevLabelConfirmation, executeJevBoundLabels } from "../integrations/jev-bound-labels.js";
import { resolveIntegrationConnection } from "../integrations/connection-selection.js";
import { delegatedIntegrationHeaders } from "../integrations/delegated-identity.js";
import { boundedOperation } from "../bounded-operation.js";
import { z } from "zod/v4";

/** One exact transport, selected at composition time; never falls back after a failed write. */
export function createJevRecipeLabelClient(options: { internalBaseUrl: string | null; machineToken?: string;
  db?: PlatformDb | null; pipedream?: PipedreamConnectClient | null;
  fetcher?: (url: string, init: RequestInit) => Promise<Response> }) {
  return async (ownerId: string, scope: HermesJevScope, raw: z.infer<typeof JevLabelInput>, parent?: AbortSignal) => {
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
          connection: selected.connection, binding, input, pipedream: options.pipedream, signal });
      }
      if (!options.machineToken) throw new Error("Labeling unavailable");
      const response = await (options.fetcher ?? fetch)(`${options.internalBaseUrl.replace(/\/$/, "")}/jev-label-call`, {
        method: "POST", body: JSON.stringify({ binding, input }), redirect: "error", signal,
        headers: { Authorization: `Bearer ${options.machineToken}`, "content-type": "application/json",
          ...delegatedIntegrationHeaders(ownerId, options.machineToken) } });
      const cancel = () => { void response.body?.cancel().catch((error: unknown) => console.warn("[jev-labels] Response cleanup failed", {
        errorName: error instanceof Error ? error.name : "UnknownError" })); };
      const length = response.headers.get("content-length");
      if (signal.aborted || !response.ok || !response.body || (length !== null && (!/^\d+$/.test(length) || Number(length) > 16 * 1024))) {
        cancel(); throw new Error("Labeling unconfirmed");
      }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      const aborted = () => { void reader.cancel().catch((error: unknown) => console.warn("[jev-labels] Read cleanup failed", {
        errorName: error instanceof Error ? error.name : "UnknownError" })); };
      signal.addEventListener("abort", aborted, { once: true });
      try {
        for (;;) {
          signal.throwIfAborted(); const next = await reader.read(); if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > 16 * 1024 || chunks.length >= 4096) throw new Error("Labeling unconfirmed");
          chunks.push(next.value);
        }
        signal.throwIfAborted();
        return JevLabelConfirmation.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes))));
      } catch (error) { aborted(); throw error; }
      finally { signal.removeEventListener("abort", aborted); reader.releaseLock(); }
    }, 45_000, parent);
  };
}

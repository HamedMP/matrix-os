import { useEffect, useRef, useState } from "react";
import type { ProviderWorkflow } from "@matrix-os/contracts";
import type { ProviderWorkflowClient } from "./types.js";
import { ProviderWorkflowClientError } from "./provider-workflow-client.js";

const active = (operation: ProviderWorkflow | null) =>
  operation?.state === "pending" || operation?.state === "running";

/** Read-only recovery is bounded by the server receipt's expiry and UI scope. */
export function useWorkflowPolling(input: {
  operation: ProviderWorkflow | null; client: ProviderWorkflowClient; harnessId: string;
  onUpdate: (operation: ProviderWorkflow) => void; onFailure: () => void;
}) {
  const [generation, setGeneration] = useState(0);
  const callbacks = useRef(input);
  useEffect(() => { callbacks.current = input; });
  const stop = useRef<() => void>(() => undefined);
  const { operation, client, harnessId } = input;
  const id = operation?.id;
  const state = operation?.state;
  const kind = operation?.kind;
  const expiresAt = operation?.expiresAt;
  useEffect(() => {
    if (!id || (state !== "pending" && state !== "running") || !expiresAt) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const deadline = Date.parse(expiresAt);
    const cleanup = () => { controller.abort(); clearTimeout(timer); };
    stop.current = cleanup;
    const schedule = () => {
      const remaining = deadline - Date.now();
      if (controller.signal.aborted) return;
      if (!Number.isFinite(remaining) || remaining <= 0) {
        callbacks.current.onFailure();
        cleanup();
        return;
      }
      timer = setTimeout(poll, Math.min(remaining, Math.min(10_000, 2000 * 2 ** Math.min(failures, 3))));
    };
    const poll = async () => {
      if (Date.now() >= deadline) { callbacks.current.onFailure(); cleanup(); return; }
      try {
        const next = await client.get(id, controller.signal);
        if (controller.signal.aborted) return;
        if (next.id !== id || next.harnessInstanceId !== harnessId || next.kind !== kind) {
          callbacks.current.onFailure(); cleanup(); return;
        }
        failures = 0;
        callbacks.current.onUpdate(next);
        if (active(next)) schedule();
        else cleanup();
      } catch (error) {
        if (controller.signal.aborted) return;
        callbacks.current.onFailure();
        if (error instanceof ProviderWorkflowClientError && error.reason === "unavailable") {
          failures += 1;
          schedule();
        } else cleanup();
      }
    };
    schedule();
    return cleanup;
  }, [id, state, kind, expiresAt, client, harnessId, generation]);
  return { stop: () => stop.current(), restart: () => setGeneration(value => value + 1) };
}

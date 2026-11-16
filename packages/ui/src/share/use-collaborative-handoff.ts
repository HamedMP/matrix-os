import { useCallback, useEffect, useRef, useState } from "react";
import {
  COLLABORATIVE_HANDOFF_EVENT, collaborativeHandoffPath, parseCollaborativeHandoff,
  type CollaborativeHandoffRecord,
} from "@matrix-os/contracts";

/** Minimal owner file API (Web `shellApi`, Electron `ApiClient.forRuntime`). */
export interface HandoffFileApi {
  get(path: string, options?: { signal?: AbortSignal }): Promise<unknown>;
  put(path: string, body: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
}

export const HANDOFF_POLL_MS = 5_000;
/** After 30 minutes of fast polling, keep watching once a minute while the app window is open. */
export const HANDOFF_FAST_POLLS = 360;
export const HANDOFF_SLOW_POLL_MS = 60_000;

const blobPath = (path: string) => `/api/files/blob?path=${encodeURIComponent(path)}`;
const handoffIntentPath = (resultPath: string) => resultPath.replace(/\.json$/, ".intent.json");
const cancelStorageKey = (appSlug: string) => `matrix:org-share:cancelled:${appSlug}`;

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { category?: unknown; status?: unknown; httpStatus?: unknown };
  return value.category === "notFound" || value.status === 404 || value.httpStatus === 404;
}

/**
 * Tracks the "Make app collaborative" handoff record for one app. While the
 * skill runs, the record is re-read on a bounded interval; the skill's write of
 * `completed`/`failed` is the completion event (see contracts/collaborative-app-handoff).
 */
export function useCollaborativeHandoff({ appSlug, api }: { appSlug: string; api: HandoffFileApi | null }) {
  const [loadedRecord, setRecord] = useState<CollaborativeHandoffRecord | null>(null);
  const [writeFailed, setWriteFailed] = useState(false);
  const generation = useRef(0);
  const pendingWrites = useRef(0);
  const cancelledRequest = useRef<string | null>(null);
  const record = api && loadedRecord?.appSlug === appSlug ? loadedRecord : null;
  const storageKey = cancelStorageKey(appSlug);

  const isCancelled = useCallback((requestId: string): boolean => {
    if (cancelledRequest.current === requestId) return true;
    try {
      return window.localStorage.getItem(storageKey) === requestId;
    } catch (error: unknown) {
      console.warn("[share] local handoff cancellation unavailable", error instanceof Error ? error.name : "UnknownError");
      return false;
    }
  }, [storageKey]);

  const read = useCallback(async (signal?: AbortSignal): Promise<CollaborativeHandoffRecord | null> => {
    if (!api) return null;
    const resultPath = collaborativeHandoffPath(appSlug);
    const load = async (path: string, isIntent: boolean) => {
      try {
        const next = parseCollaborativeHandoff(await api.get(blobPath(path), { signal }), appSlug);
        if (isIntent && (!next || next.state === "completed" || next.state === "failed")) {
          throw new Error("Invalid handoff intent");
        }
        return next;
      } catch (error: unknown) {
        if (isNotFound(error)) return null;
        throw error;
      }
    };
    const result = await load(resultPath, false);
    // Read intent after the builder result to observe a Cancel saved while that read was in flight.
    // react-doctor-disable-next-line react-doctor/server-sequential-independent-await -- the intent snapshot must come after the builder result.
    const intent = await load(handoffIntentPath(resultPath), true);
    if (!intent) return result; // Legacy handoffs predate the separate intent file.
    if (intent.state !== "running") return intent;
    if (result?.requestId === intent.requestId && result.organizationId === intent.organizationId
      && (result.state === "completed" || result.state === "failed")) return result;
    return intent;
  }, [api, appSlug]);

  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    const current = ++generation.current;
    void read(controller.signal).then((next) => {
      if (controller.signal.aborted || generation.current !== current) return;
      setRecord(next && isCancelled(next.requestId) ? { ...next, state: "cancelled" } : next);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) console.warn("[share] handoff read failed", error instanceof Error ? error.name : "UnknownError");
    });
    return () => controller.abort();
  }, [api, isCancelled, read]);

  const running = record?.state === "running";
  const requestId = record?.requestId;
  useEffect(() => {
    if (!api || !running) return;
    const current = generation.current;
    let polls = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const active = () => !controller.signal.aborted && generation.current === current
      && requestId !== undefined && !isCancelled(requestId);
    const poll = async () => {
      if (!active()) return;
      polls += 1;
      try {
        const next = await read(controller.signal);
        if (!active()) return;
        // Only the active request's completion counts; a stray record is ignored.
        if (next && next.requestId === requestId && next.state !== "running") { setRecord(next); return; }
      } catch (error: unknown) {
        if (!active()) return;
        console.warn("[share] handoff poll failed", error instanceof Error ? error.name : "UnknownError");
      }
      timer = setTimeout(() => { void poll(); }, polls < HANDOFF_FAST_POLLS ? HANDOFF_POLL_MS : HANDOFF_SLOW_POLL_MS);
    };
    timer = setTimeout(() => { void poll(); }, HANDOFF_POLL_MS);
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [api, isCancelled, read, running, requestId]);

  const write = useCallback(async (next: CollaborativeHandoffRecord): Promise<CollaborativeHandoffRecord | null> => {
    if (!api) return null;
    const current = ++generation.current;
    pendingWrites.current += 1;
    try {
      await api.put(`${blobPath(handoffIntentPath(collaborativeHandoffPath(appSlug)))}&force=true`, next);
      if (generation.current !== current) return null;
      setRecord(next);
      setWriteFailed(false);
      return next;
    } catch (error: unknown) {
      console.warn("[share] handoff write failed", error instanceof Error ? error.name : "UnknownError");
      if (generation.current === current) setWriteFailed(true);
      return null;
    } finally {
      pendingWrites.current -= 1;
    }
  }, [api, appSlug]);

  const cancel = (target = record) => {
    if (!target) return Promise.resolve(null);
    const next: CollaborativeHandoffRecord = { ...target, state: "cancelled", updatedAt: new Date().toISOString() };
    cancelledRequest.current = next.requestId;
    // A reload during the PUT can still see the old owner file.
    try { window.localStorage.setItem(storageKey, next.requestId); }
    catch (error: unknown) {
      console.warn("[share] could not store local handoff cancellation", error instanceof Error ? error.name : "UnknownError");
    }
    setRecord(next);
    return write(next);
  };

  return {
    record,
    writeFailed,
    isCancelled,
    /** Owner chose "Start in Chats" for this organization. */
    start: (organizationId: string) => pendingWrites.current > 0 ? Promise.resolve(null) : write({
      version: 1, event: COLLABORATIVE_HANDOFF_EVENT, requestId: crypto.randomUUID(), appSlug, organizationId,
      state: "running", updatedAt: new Date().toISOString(),
    }),
    cancel,
    markApplied: () => record && !isCancelled(record.requestId)
      ? write({ ...record, state: "applied", updatedAt: new Date().toISOString() })
      : Promise.resolve(null),
  };
}

export type CollaborativeHandoff = ReturnType<typeof useCollaborativeHandoff>;

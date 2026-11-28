import { randomUUID } from "../random-uuid.js";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  COLLABORATIVE_HANDOFF_EVENT, collaborativeHandoffPath, parseCollaborativeHandoff,
  type CollaborativeHandoffRecord, type CollaborativeHandoffState,
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

const blobPath = (appSlug: string) => `/api/files/blob?path=${encodeURIComponent(collaborativeHandoffPath(appSlug))}`;
// The record is replaced on every transition; the blob route refuses overwrites without force.
const blobWritePath = (appSlug: string) => `${blobPath(appSlug)}&force=true`;

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
  const [record, setRecord] = useState<CollaborativeHandoffRecord | null>(null);
  const [writeFailed, setWriteFailed] = useState(false);
  const generation = useRef(0);
  /** Latest record, updated synchronously by writes so queued writes validate against it. */
  const latest = useRef<CollaborativeHandoffRecord | null>(null);
  const commit = useCallback((next: CollaborativeHandoffRecord | null) => { latest.current = next; setRecord(next); }, []);
  /** Writes run one at a time, in order, so an older write can never land after a newer one. */
  const queue = useRef<Promise<unknown> | null>(null);

  const read = useCallback(async (signal?: AbortSignal): Promise<CollaborativeHandoffRecord | null> => {
    if (!api) return null;
    try {
      return parseCollaborativeHandoff(await api.get(blobPath(appSlug), { signal }), appSlug);
    } catch (error: unknown) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }, [api, appSlug]);

  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    const current = ++generation.current;
    void read(controller.signal).then((next) => {
      if (generation.current === current) commit(next);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) console.warn("[share] handoff read failed", error instanceof Error ? error.name : "UnknownError");
    });
    return () => controller.abort();
  }, [api, read, commit]);

  const running = record?.state === "running";
  const requestId = record?.requestId;
  useEffect(() => {
    if (!api || !running) return;
    let polls = 0;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const poll = async () => {
      if (cancelled) return;
      polls += 1;
      try {
        const next = await read(controller.signal);
        if (cancelled) return;
        // Only the active request's completion counts; a stray record is ignored.
        if (next && next.requestId === requestId && next.state !== "running") { commit(next); return; }
      } catch (error: unknown) {
        if (cancelled) return;
        console.warn("[share] handoff poll failed", error instanceof Error ? error.name : "UnknownError");
      }
      timer = setTimeout(() => { void poll(); }, polls < HANDOFF_FAST_POLLS ? HANDOFF_POLL_MS : HANDOFF_SLOW_POLL_MS);
    };
    timer = setTimeout(() => { void poll(); }, HANDOFF_POLL_MS);
    return () => { cancelled = true; controller.abort(); if (timer) clearTimeout(timer); };
  }, [api, read, running, requestId, commit]);

  /** `build` runs when the write's turn comes and returns null to skip a write that is no longer wanted. */
  const write = useCallback((build: (current: CollaborativeHandoffRecord | null) => CollaborativeHandoffRecord | null): Promise<CollaborativeHandoffRecord | null> => {
    const run = (queue.current ?? Promise.resolve()).then(async () => {
      if (!api) return null;
      const next = build(latest.current);
      if (!next) return null;
      generation.current += 1;
      try {
        await api.put(blobWritePath(appSlug), next);
        commit(next); setWriteFailed(false);
        return next;
      } catch (error: unknown) {
        console.warn("[share] handoff write failed", error instanceof Error ? error.name : "UnknownError");
        setWriteFailed(true);
        return null;
      }
    });
    queue.current = run.catch((error: unknown) => {
      console.warn("[share] handoff write queue failed", error instanceof Error ? error.name : "UnknownError");
    });
    return run;
  }, [api, appSlug, commit]);

  /** Transitions only the request that was current when asked; a newer request is never overwritten. */
  const transition = useCallback((state: CollaborativeHandoffState) => {
    const requestId = record?.requestId;
    if (!requestId) return Promise.resolve(null);
    return write((current) => current && current.requestId === requestId
      ? { ...current, state, updatedAt: new Date().toISOString() }
      : null);
  }, [record?.requestId, write]);

  return {
    record,
    writeFailed,
    /** Owner chose "Start in Chats" for this organization. */
    start: (organizationId: string) => write(() => ({
      version: 1, event: COLLABORATIVE_HANDOFF_EVENT, requestId: randomUUID(), appSlug, organizationId,
      state: "running", updatedAt: new Date().toISOString(),
    })),
    cancel: () => transition("cancelled"),
    markApplied: () => transition("applied"),
  };
}

export type CollaborativeHandoff = ReturnType<typeof useCollaborativeHandoff>;

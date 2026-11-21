import { useCallback, useEffect, useRef, useState } from "react";
import type { JoinCodeResponse, PairedMachinesResponse, PrivateNetworkClient } from "./client.js";
import { MACHINES_POLL_MS, PRIVATE_NETWORK_ERRORS, logRequestFailure, minutesLeft, requestErrorStatus } from "./presentation.js";

export interface PairedMachinesModel {
  list: PairedMachinesResponse | null;
  loading: boolean;
  error: string | null;
  joinCode: JoinCodeResponse | null;
  creatingJoinCode: boolean;
  removingId: string | null;
  now: number;
  reload(): void;
  createJoinCode(): Promise<void>;
  removeMachine(id: string): Promise<boolean>;
}

/** Paired machines list, join-code creation, and removal for a connected computer. */
export function usePairedMachines(client: PrivateNetworkClient): PairedMachinesModel {
  const [list, setList] = useState<PairedMachinesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState<JoinCodeResponse | null>(null);
  const [creatingJoinCode, setCreatingJoinCode] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [loadRevision, setLoadRevision] = useState(0);
  // The load revision whose read has settled; the next poll waits for it.
  const [settledRevision, setSettledRevision] = useState(-1);
  const lifetime = useRef<AbortController | null>(null);
  const listRef = useRef<PairedMachinesResponse | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  // The pairing revision only grows: a read that started before a removal (or
  // another tab's change) and finished after it must not bring old rows back.
  const applyList = useCallback((next: PairedMachinesResponse) => {
    const current = listRef.current;
    if (current && next.revision < current.revision) return;
    listRef.current = next;
    setList(next);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    client
      .machines(controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        applyList(next);
        // A successful read clears only its own load error; a removal conflict stays visible.
        setError((previous) => (previous === PRIVATE_NETWORK_ERRORS.machines ? null : previous));
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        logRequestFailure("machines", failure);
        setError(PRIVATE_NETWORK_ERRORS.machines);
      })
      .finally(() => {
        if (controller.signal.aborted) return;
        setLoading(false);
        setSettledRevision(loadRevision);
      });
    return () => controller.abort();
  }, [client, loadRevision, applyList]);

  const joinCodeActive = joinCode !== null && minutesLeft(joinCode.expiresAt, now) > 0;
  const loadSettled = settledRevision === loadRevision;
  useEffect(() => {
    // Chain polls: a read can take up to the gateway's `tailscale status` wait,
    // so the next one starts only after the current read settles.
    if (!joinCodeActive || !loadSettled) return;
    const timer = setTimeout(() => {
      setNow(Date.now());
      setLoadRevision((revision) => revision + 1);
    }, MACHINES_POLL_MS);
    return () => clearTimeout(timer);
  }, [joinCodeActive, loadSettled]);

  const reload = useCallback(() => {
    setError(null);
    setLoadRevision((revision) => revision + 1);
  }, []);

  const createJoinCode = useCallback(async () => {
    const signal = lifetime.current?.signal;
    if (!signal) return;
    setCreatingJoinCode(true);
    setError(null);
    try {
      const next = await client.createJoinCode(signal);
      if (signal.aborted) return;
      setNow(Date.now());
      setJoinCode(next);
    } catch (failure: unknown) {
      if (signal.aborted) return;
      logRequestFailure("join code", failure);
      setError(PRIVATE_NETWORK_ERRORS.joinCode);
    } finally {
      if (!signal.aborted) setCreatingJoinCode(false);
    }
  }, [client]);

  const removeMachine = useCallback(
    async (id: string) => {
      const signal = lifetime.current?.signal;
      const current = listRef.current;
      if (!signal || !current) return false;
      setRemovingId(id);
      setError(null);
      try {
        const next = await client.removeMachine(id, current.revision, signal);
        if (signal.aborted) return false;
        applyList(next);
        return true;
      } catch (failure: unknown) {
        if (signal.aborted) return false;
        logRequestFailure("remove machine", failure);
        if (requestErrorStatus(failure) === 409) {
          // The list changed elsewhere: reload it so a retry sends the current revision.
          setError(PRIVATE_NETWORK_ERRORS.removeConflict);
          setLoadRevision((revision) => revision + 1);
        } else {
          setError(PRIVATE_NETWORK_ERRORS.remove);
        }
        return false;
      } finally {
        if (!signal.aborted) setRemovingId(null);
      }
    },
    [client, applyList],
  );

  return { list, loading, error, joinCode, creatingJoinCode, removingId, now, reload, createJoinCode, removeMachine };
}

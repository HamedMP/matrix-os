import { useCallback, useEffect, useRef, useState } from "react";
import type { PrivateNetworkClient, PrivateNetworkStatus } from "./client.js";
import {
  LOGIN_POLL_LIMIT_MS,
  PRIVATE_NETWORK_ERRORS,
  STATUS_IDLE_POLL_MS,
  STATUS_POLL_MS,
  logRequestFailure,
  requestErrorStatus,
  shouldHidePanel,
} from "./presentation.js";

export type StatusPhase = "loading" | "hidden" | "ready" | "failed";
export type StatusAction = "connect" | "disconnect" | null;

export interface PrivateNetworkStatusModel {
  phase: StatusPhase;
  status: PrivateNetworkStatus | null;
  action: StatusAction;
  error: string | null;
  loginTimedOut: boolean;
  retry(): void;
  connect(): Promise<void>;
  disconnect(): Promise<boolean>;
}

/** Status, connect/disconnect actions, and needs-login polling bound to one panel lifetime. */
export function usePrivateNetworkStatus(client: PrivateNetworkClient): PrivateNetworkStatusModel {
  const [phase, setPhase] = useState<StatusPhase>("loading");
  const [status, setStatus] = useState<PrivateNetworkStatus | null>(null);
  const [action, setAction] = useState<StatusAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);
  const [pollTick, setPollTick] = useState(0);
  const [loginTimedOut, setLoginTimedOut] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  const loginDeadline = useRef<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    client
      .status(controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setStatus(next);
        setPhase(shouldHidePanel(next) ? "hidden" : "ready");
        setError(null);
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        logRequestFailure("status", failure);
        setPhase(requestErrorStatus(failure) === 404 ? "hidden" : "failed");
        setError(PRIVATE_NETWORK_ERRORS.load);
      });
    return () => controller.abort();
  }, [client, loadRevision]);

  const state = status?.state;
  useEffect(() => {
    // Polls while the panel is shown: fast during a login, slowly once settled,
    // so a change made in another tab or on the server shows here too.
    if (phase !== "ready" || !state || state === "unsupported") return;
    if (state !== "needs-login") loginDeadline.current = null;
    else {
      loginDeadline.current ??= Date.now() + LOGIN_POLL_LIMIT_MS;
      if (Date.now() >= loginDeadline.current) {
        setLoginTimedOut(true);
        return;
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      client
        .status(controller.signal)
        .then((next) => {
          if (controller.signal.aborted) return;
          setStatus(next);
          setPollTick((tick) => tick + 1);
        })
        .catch((failure: unknown) => {
          if (controller.signal.aborted) return;
          logRequestFailure("status poll", failure);
          setPollTick((tick) => tick + 1);
        });
    }, state === "needs-login" ? STATUS_POLL_MS : STATUS_IDLE_POLL_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [client, phase, state, pollTick]);

  const retry = useCallback(() => {
    setPhase((current) => (current === "failed" ? "loading" : current));
    setError(null);
    setLoadRevision((revision) => revision + 1);
  }, []);

  const connect = useCallback(async () => {
    const signal = lifetime.current?.signal;
    if (!signal) return;
    setAction("connect");
    setError(null);
    setLoginTimedOut(false);
    loginDeadline.current = null;
    try {
      const next = await client.connect(signal);
      if (signal.aborted) return;
      setStatus(next);
      setPollTick((tick) => tick + 1);
    } catch (failure: unknown) {
      if (signal.aborted) return;
      logRequestFailure("connect", failure);
      setError(PRIVATE_NETWORK_ERRORS.connect);
    } finally {
      if (!signal.aborted) setAction(null);
    }
  }, [client]);

  const disconnect = useCallback(async () => {
    const signal = lifetime.current?.signal;
    if (!signal) return false;
    setAction("disconnect");
    setError(null);
    try {
      const next = await client.disconnect(signal);
      if (signal.aborted) return false;
      setStatus(next);
      return true;
    } catch (failure: unknown) {
      if (signal.aborted) return false;
      logRequestFailure("disconnect", failure);
      setError(PRIVATE_NETWORK_ERRORS.disconnect);
      return false;
    } finally {
      if (!signal.aborted) setAction(null);
    }
  }, [client]);

  return { phase, status, action, error, loginTimedOut, retry, connect, disconnect };
}

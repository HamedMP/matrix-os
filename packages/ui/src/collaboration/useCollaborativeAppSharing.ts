import {
  CollaborativeAppReadinessSchema,
  CollaborationOrganizationIdSchema,
  type CollaborativeAppReadiness,
} from "@matrix-os/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod/v4";

const AppIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
const RecheckInputSchema = z.object({
  organizationId: CollaborationOrganizationIdSchema,
  expectedRegistrationIncarnation: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  clientRequestId: z.uuid().optional(),
}).strict();
const CurrentRegistrationSchema = z.object({
  registrationIncarnation: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const SAFE_UNAVAILABLE = "App collaboration readiness is unavailable.";
const CHECKING_POLL_MS = 5_000;
const MAX_CHECKING_POLLS = 36;

export interface CollaborativeAppReadinessApi {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
}

export type CollaborativeAppSharingState = "idle" | "loading" | "checking"
  | "blocked" | "ready" | "stale" | "failed";

export function useCollaborativeAppSharing(input: {
  appId: string;
  api: CollaborativeAppReadinessApi;
  buildEpoch?: number;
}) {
  const [readiness, setReadiness] = useState<CollaborativeAppReadiness | null>(null);
  const [readinessRequestKey, setReadinessRequestKey] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "checking">("loading");
  const [safeMessage, setSafeMessage] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const appId = AppIdSchema.safeParse(input.appId);
  const path = appId.success
    ? `/api/collaboration/apps/${encodeURIComponent(appId.data)}/readiness`
    : null;
  const buildEpoch = Number.isSafeInteger(input.buildEpoch) && (input.buildEpoch ?? -1) >= 0
    ? input.buildEpoch!
    : 0;
  const requestKey = `${path ?? "invalid"}:${buildEpoch}`;
  const currentReadiness = readinessRequestKey === requestKey ? readiness : null;

  const fail = useCallback((generation: number, error: unknown, failedRequestKey: string) => {
    console.warn("[collaborative-app-readiness] request failed", error instanceof Error ? error.name : "UnknownError");
    if (requestGeneration.current !== generation) return;
    setReadiness(null);
    setReadinessRequestKey(failedRequestKey);
    setPhase("idle");
    setSafeMessage(SAFE_UNAVAILABLE);
  }, []);

  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setPhase("loading");
    setSafeMessage(null);
    if (!path) {
      fail(generation, new Error("InvalidAppId"), requestKey);
      return;
    }
    try {
      const raw = await input.api.get(path);
      const parsed = raw === null ? null : CollaborativeAppReadinessSchema.parse(raw);
      if (requestGeneration.current !== generation) return;
      setReadiness(parsed);
      setReadinessRequestKey(requestKey);
      setPhase("idle");
    } catch (error: unknown) {
      fail(generation, error, requestKey);
    }
  }, [fail, input.api, path, requestKey]);

  useEffect(() => {
    void refresh();
    return () => { requestGeneration.current += 1; };
  }, [refresh]);

  useEffect(() => {
    if (!path || readinessRequestKey !== requestKey || currentReadiness?.status !== "checking" || phase !== "idle") return;
    const generation = requestGeneration.current;
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (++attempts > MAX_CHECKING_POLLS) {
        fail(generation, new Error("ReadinessCheckTimedOut"), requestKey);
        return;
      }
      try {
        const raw = await input.api.get(path);
        const next = raw === null ? null : CollaborativeAppReadinessSchema.parse(raw);
        if (cancelled || requestGeneration.current !== generation) return;
        setReadiness(next);
        if (next?.status === "checking") timer = setTimeout(() => { void poll(); }, CHECKING_POLL_MS);
      } catch (error: unknown) {
        if (cancelled || requestGeneration.current !== generation) return;
        if (error instanceof z.ZodError || (typeof error === "object" && error !== null
          && "category" in error && (error.category === "unauthorized" || error.category === "notFound"))) {
          fail(generation, error, requestKey);
          return;
        }
        console.warn("[collaborative-app-readiness] poll retry", error instanceof Error ? error.name : "UnknownError");
        timer = setTimeout(() => { void poll(); }, CHECKING_POLL_MS);
      }
    };
    timer = setTimeout(() => { void poll(); }, CHECKING_POLL_MS);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [currentReadiness?.status, fail, input.api, path, phase, readinessRequestKey, requestKey]);

  const recheck = useCallback(async (rawInput: {
    organizationId: string;
    expectedRegistrationIncarnation?: string;
    clientRequestId?: string;
  }) => {
    const generation = ++requestGeneration.current;
    setPhase("checking");
    setSafeMessage(null);
    try {
      const parsed = RecheckInputSchema.parse(rawInput);
      if (!path) throw new Error("ReadinessUnavailable");
      const expectedRegistrationIncarnation = parsed.expectedRegistrationIncarnation
        ?? currentReadiness?.build.registrationIncarnation
        ?? CurrentRegistrationSchema.parse(await input.api.get(`${path}/registration`)).registrationIncarnation;
      const response = await input.api.post(`${path}/check`, {
        organizationId: parsed.organizationId,
        clientRequestId: parsed.clientRequestId ?? crypto.randomUUID(),
        expectedRegistrationIncarnation,
      });
      const next = CollaborativeAppReadinessSchema.parse(response);
      if (requestGeneration.current !== generation) return;
      setReadiness(next);
      setReadinessRequestKey(requestKey);
      setPhase("idle");
    } catch (error: unknown) {
      fail(generation, error, requestKey);
    }
  }, [currentReadiness?.build.registrationIncarnation, fail, input.api, path, requestKey]);

  const state: CollaborativeAppSharingState = readinessRequestKey !== requestKey
    ? "loading"
    : phase === "loading" || phase === "checking"
    ? phase
    : currentReadiness?.status ?? (safeMessage ? "failed" : "idle");
  return {
    readiness: currentReadiness,
    state,
    safeMessage,
    canShare: readinessRequestKey === requestKey && phase === "idle" && currentReadiness?.status === "ready",
    refresh,
    recheck,
  };
}

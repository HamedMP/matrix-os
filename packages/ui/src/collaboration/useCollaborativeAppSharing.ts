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
const SAFE_UNAVAILABLE = "App collaboration readiness is unavailable.";

export interface CollaborativeAppReadinessApi {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
}

export type CollaborativeAppSharingState = "idle" | "loading" | "checking"
  | "blocked" | "ready" | "stale" | "failed";

export function useCollaborativeAppSharing(input: {
  appId: string;
  api: CollaborativeAppReadinessApi;
}) {
  const [readiness, setReadiness] = useState<CollaborativeAppReadiness | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "checking">("loading");
  const [safeMessage, setSafeMessage] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const appId = AppIdSchema.safeParse(input.appId);
  const path = appId.success
    ? `/api/collaboration/apps/${encodeURIComponent(appId.data)}/readiness`
    : null;

  const fail = useCallback((generation: number, error: unknown) => {
    console.warn("[collaborative-app-readiness] request failed", error instanceof Error ? error.name : "UnknownError");
    if (requestGeneration.current !== generation) return;
    setReadiness(null);
    setPhase("idle");
    setSafeMessage(SAFE_UNAVAILABLE);
  }, []);

  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setPhase("loading");
    setSafeMessage(null);
    if (!path) {
      fail(generation, new Error("InvalidAppId"));
      return;
    }
    try {
      const raw = await input.api.get(path);
      const parsed = raw === null ? null : CollaborativeAppReadinessSchema.parse(raw);
      if (requestGeneration.current !== generation) return;
      setReadiness(parsed);
      setPhase("idle");
    } catch (error: unknown) {
      fail(generation, error);
    }
  }, [fail, input.api, path]);

  useEffect(() => {
    void refresh();
    return () => { requestGeneration.current += 1; };
  }, [refresh]);

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
      const expectedRegistrationIncarnation = parsed.expectedRegistrationIncarnation
        ?? readiness?.build.registrationIncarnation;
      if (!path || !expectedRegistrationIncarnation) throw new Error("ReadinessUnavailable");
      const response = await input.api.post(`${path}/check`, {
        organizationId: parsed.organizationId,
        clientRequestId: parsed.clientRequestId ?? crypto.randomUUID(),
        expectedRegistrationIncarnation,
      });
      const next = CollaborativeAppReadinessSchema.parse(response);
      if (requestGeneration.current !== generation) return;
      setReadiness(next);
      setPhase("idle");
    } catch (error: unknown) {
      fail(generation, error);
    }
  }, [fail, input.api, path, readiness?.build.registrationIncarnation]);

  const state: CollaborativeAppSharingState = phase === "loading" || phase === "checking"
    ? phase
    : readiness?.status ?? (safeMessage ? "failed" : "idle");
  return {
    readiness,
    state,
    safeMessage,
    canShare: phase === "idle" && readiness?.status === "ready",
    refresh,
    recheck,
  };
}

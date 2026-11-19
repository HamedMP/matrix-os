import {
  CollaborativeAppReadinessSchema,
  CollaborativeAppShareSchema,
  CollaborationOrganizationIdSchema,
  type CollaborativeAppReadiness,
  type CollaborativeAppShare,
} from "@matrix-os/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod/v4";

const AppIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
const RecheckInputSchema = z.strictObject({
  organizationId: CollaborationOrganizationIdSchema,
  expectedRegistrationIncarnation: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  clientRequestId: z.uuid().optional(),
});
const CurrentRegistrationSchema = z.strictObject({
  registrationIncarnation: z.string().regex(/^[a-f0-9]{64}$/),
});
const CreateShareInputSchema = z.strictObject({
  organizationId: CollaborationOrganizationIdSchema,
  clientRequestId: z.uuid().optional(),
});
const PreflightSchema = z.discriminatedUnion("eligible", [
  z.strictObject({
    eligible: z.literal(true),
    catalogId: z.uuid(),
    resourceRevision: z.string().regex(/^\d+$/),
    readinessId: z.uuid(),
    buildId: z.string().regex(/^[a-f0-9]{64}$/),
    confirmationToken: z.string().min(16).max(8_192),
    existingShare: CollaborativeAppShareSchema.optional(),
  }),
  z.strictObject({
    eligible: z.literal(false),
    reason: z.enum(["not_ready", "readiness_stale", "organization_mismatch", "already_shared", "unavailable"]),
  }),
]);
const SAFE_UNAVAILABLE = "App collaboration readiness is unavailable.";
const CHECKING_POLL_MS = 5_000;
const MAX_CHECKING_POLLS = 36;
const SAFE_SHARE_UNAVAILABLE = "App sharing is unavailable. Try again.";

export interface CollaborativeAppReadinessApi {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
  delete?(path: string, body?: unknown): Promise<unknown>;
}

export type CollaborativeAppSharingState = "idle" | "loading" | "checking"
  | "blocked" | "ready" | "stale" | "failed";
export type CollaborativeAppSharingActionState = "idle" | "loading" | "sharing" | "stopping" | "failed";

// react-doctor-disable-next-line react-doctor/no-high-complexity-react-function -- One bounded owner-sharing state machine coordinates readiness, CAS share lifecycle, and stale-request generations. Splitting it would duplicate the generation and failure invariants across hooks.
export function useCollaborativeAppSharing(input: {
  appId: string;
  api: CollaborativeAppReadinessApi;
  buildEpoch?: number;
  manageShare?: boolean;
}) {
  const [readiness, setReadiness] = useState<CollaborativeAppReadiness | null>(null);
  const [readinessRequestKey, setReadinessRequestKey] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "checking">("loading");
  const [safeMessage, setSafeMessage] = useState<string | null>(null);
  const [share, setShare] = useState<CollaborativeAppShare | null>(null);
  const [shareKnown, setShareKnown] = useState(!input.manageShare);
  const [actionState, setActionState] = useState<CollaborativeAppSharingActionState>(
    input.manageShare ? "loading" : "idle",
  );
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const shareGeneration = useRef(0);
  // Rebuild reads wait for an owner write so they cannot invalidate its result.
  const pendingWrite = useRef<number | null>(null);
  const rereadAfterWrite = useRef(false);
  const shareScope = useRef(0);
  const handledBuildEpoch = useRef<number | null>(null);
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

  const refreshShare = useCallback(async () => {
    const generation = ++shareGeneration.current;
    setShareKnown(false);
    setActionState("loading");
    setActionMessage(null);
    if (!input.manageShare || !path) {
      setShare(null);
      setShareKnown(true);
      setActionState("idle");
      return { ok: true as const, share: null };
    }
    try {
      const raw = await input.api.get(path.replace(/\/readiness$/, "/share"));
      const next = raw === null ? null : CollaborativeAppShareSchema.parse(raw);
      if (shareGeneration.current !== generation) return { ok: false as const };
      setShare(next);
      setShareKnown(true);
      setActionState("idle");
      return { ok: true as const, share: next };
    } catch (error: unknown) {
      console.warn("[collaborative-app-share] state unavailable", error instanceof Error ? error.name : "UnknownError");
      if (shareGeneration.current !== generation) return { ok: false as const };
      setShareKnown(false);
      setActionState("failed");
      setActionMessage(SAFE_SHARE_UNAVAILABLE);
      return { ok: false as const };
    }
  }, [input.api, input.manageShare, path]);

  useEffect(() => {
    if (input.manageShare) void refreshShare();
    return () => {
      shareGeneration.current += 1;
      shareScope.current += 1;
      pendingWrite.current = null;
      rereadAfterWrite.current = false;
      handledBuildEpoch.current = null;
    };
  }, [input.manageShare, refreshShare]);

  useEffect(() => {
    const previous = handledBuildEpoch.current;
    handledBuildEpoch.current = buildEpoch;
    if (previous === null || previous === buildEpoch || !input.manageShare) return;
    if (pendingWrite.current !== null) rereadAfterWrite.current = true;
    else void refreshShare();
  }, [buildEpoch, input.manageShare, refreshShare]);

  const settleWrite = useCallback((generation: number, scope: number, confirmed: boolean) => {
    if (shareScope.current !== scope || pendingWrite.current !== generation) return;
    pendingWrite.current = null;
    const reread = rereadAfterWrite.current;
    rereadAfterWrite.current = false;
    // Failed stops perform their own read and retain their safe error.
    if (reread && confirmed) void refreshShare();
  }, [refreshShare]);

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

  /** Deletes one known share by its own revisions; null when that failed. */
  const revokeShare = useCallback(async (target: CollaborativeAppShare): Promise<CollaborativeAppShare | null> => {
    if (!path || !input.api.delete) return null;
    try {
      return CollaborativeAppShareSchema.parse(await input.api.delete(path.replace(/\/readiness$/, "/share"), {
        clientRequestId: crypto.randomUUID(),
        expectedShareRevision: target.shareRevision,
        expectedBindingRevision: target.bindingRevision,
      }));
    } catch (error: unknown) {
      console.warn("[collaborative-app-share] revoke after cancel failed", error instanceof Error ? error.name : "UnknownError");
      return null;
    }
  }, [input.api, path]);

  const createShare = useCallback(async (rawInput: {
    organizationId: string;
    clientRequestId?: string;
  }, options: {
    /** Re-checked after preflight; returning false stops before the share mutation. */
    shouldContinue?: () => boolean;
  } = {}): Promise<CollaborativeAppShare | null> => {
    const generation = ++shareGeneration.current;
    const scope = shareScope.current;
    let confirmed = false;
    pendingWrite.current = generation;
    setActionState("sharing");
    setActionMessage(null);
    try {
      const parsed = CreateShareInputSchema.parse(rawInput);
      if (!path || currentReadiness?.status !== "ready") throw new Error("ReadinessUnavailable");
      const sharePath = path.replace(/\/readiness$/, "/share");
      const preflight = PreflightSchema.parse(await input.api.post(`${sharePath}/preflight`, {
        organizationId: parsed.organizationId,
        expectedReadinessRevision: currentReadiness.revision,
        expectedBuildId: currentReadiness.build.buildId,
      }));
      if (!preflight.eligible) throw new Error(`SharePreflight:${preflight.reason}`);
      if (options.shouldContinue && !options.shouldContinue()) {
        if (shareGeneration.current === generation) setActionState("idle");
        return null;
      }
      const next = preflight.existingShare ?? CollaborativeAppShareSchema.parse(await input.api.post(sharePath, {
        organizationId: parsed.organizationId,
        clientRequestId: parsed.clientRequestId ?? crypto.randomUUID(),
        expectedResourceRevision: preflight.resourceRevision,
        expectedReadinessRevision: currentReadiness.revision,
        readinessId: preflight.readinessId,
        buildId: preflight.buildId,
        confirmationToken: preflight.confirmationToken,
      }));
      // Cancelled while the share request was in flight: revoke exactly the share
      // just created (its own revisions; the hook's snapshot is still stale here).
      if (options.shouldContinue && !options.shouldContinue() && !preflight.existingShare) {
        const revoked = await revokeShare(next);
        confirmed = revoked !== null;
        if (shareGeneration.current === generation) {
          setShare(revoked ?? next);
          setShareKnown(revoked !== null);
          setActionState(revoked ? "idle" : "failed");
          if (!revoked) setActionMessage("Sharing could not be stopped. Refresh and try again.");
        }
        return null;
      }
      if (shareGeneration.current !== generation) return null;
      setShare(next);
      setShareKnown(true);
      setActionState("idle");
      confirmed = true;
      return next;
    } catch (error: unknown) {
      console.warn("[collaborative-app-share] create failed", error instanceof Error ? error.name : "UnknownError");
      if (shareGeneration.current === generation) {
        setActionState("failed");
        setActionMessage(SAFE_SHARE_UNAVAILABLE);
      }
      return null;
    } finally {
      settleWrite(generation, scope, confirmed);
    }
  }, [currentReadiness, input.api, path, revokeShare, settleWrite]);

  const stopShare = useCallback(async (clientRequestId?: string): Promise<CollaborativeAppShare | null> => {
    const generation = ++shareGeneration.current;
    const scope = shareScope.current;
    let confirmed = false;
    pendingWrite.current = generation;
    setActionState("stopping");
    setActionMessage(null);
    try {
      if (!path || !share || !input.api.delete) throw new Error("ShareUnavailable");
      const next = CollaborativeAppShareSchema.parse(await input.api.delete(
        path.replace(/\/readiness$/, "/share"),
        {
          clientRequestId: clientRequestId ?? crypto.randomUUID(),
          expectedShareRevision: share.shareRevision,
          expectedBindingRevision: share.bindingRevision,
        },
      ));
      if (shareGeneration.current !== generation) return null;
      setShare(next);
      setShareKnown(true);
      setActionState("idle");
      confirmed = true;
      return next;
    } catch (error: unknown) {
      console.warn("[collaborative-app-share] stop failed", error instanceof Error ? error.name : "UnknownError");
      if (shareGeneration.current !== generation) return null;
      const refreshed = await refreshShare();
      if (!refreshed.ok) return null;
      setActionState("failed");
      setActionMessage("Sharing could not be stopped. Refresh and try again.");
      return null;
    } finally {
      settleWrite(generation, scope, confirmed);
    }
  }, [input.api, path, refreshShare, settleWrite, share]);

  return {
    readiness: currentReadiness,
    share,
    shareKnown,
    state,
    safeMessage,
    actionState,
    actionMessage,
    canShare: readinessRequestKey === requestKey && phase === "idle" && currentReadiness?.status === "ready",
    refresh,
    refreshShare,
    recheck,
    createShare,
    stopShare,
  };
}

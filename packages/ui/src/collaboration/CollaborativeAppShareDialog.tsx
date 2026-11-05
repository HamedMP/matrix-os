import {
  CollaborativeAppShareSchema,
  type CollaborativeAppReadiness,
  type CollaborativeAppShare,
} from "@matrix-os/contracts";
import { useState } from "react";
import { z } from "zod/v4";

import { Dialog } from "../Dialog.js";
import type { CollaborativeAppShareApi } from "./CollaborativeAppShareButton.js";
import { ReadinessSummary } from "./ReadinessSummary.js";

const PreflightSchema = z.discriminatedUnion("eligible", [
  z.object({
    eligible: z.literal(true), catalogId: z.uuid(), resourceRevision: z.string().regex(/^\d+$/),
    readinessId: z.uuid(), buildId: z.string().regex(/^[a-f0-9]{64}$/),
    confirmationToken: z.string().min(16).max(8_192), existingShare: CollaborativeAppShareSchema.optional(),
  }).strict(),
  z.object({
    eligible: z.literal(false),
    reason: z.enum(["not_ready", "readiness_stale", "organization_mismatch", "already_shared", "unavailable"]),
  }).strict(),
]);

export function CollaborativeAppShareDialog({
  appId,
  api,
  readiness,
  organizationId,
  organizationName,
  share,
  onShareChange,
  onClose,
}: {
  appId: string;
  api: CollaborativeAppShareApi;
  readiness: CollaborativeAppReadiness;
  organizationId: string;
  organizationName: string;
  share: CollaborativeAppShare | null;
  onShareChange(share: CollaborativeAppShare): void;
  onClose(): void;
}) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const active = share?.state === "active" || share?.state === "needs_recheck";
  const name = displayName(appId);

  const create = async () => {
    setPending(true); setFailure(null); setNotice(null);
    try {
      const preflight = PreflightSchema.parse(await api.post(
        `/api/collaboration/apps/${encodeURIComponent(appId)}/share/preflight`,
        { organizationId, expectedReadinessRevision: readiness.revision, expectedBuildId: readiness.build.buildId },
      ));
      if (!preflight.eligible) {
        setFailure(preflight.reason === "readiness_stale" ? "The app changed. Check readiness again."
          : preflight.reason === "organization_mismatch" ? "This app is already shared with another organization."
          : "This app is not ready to share.");
        return;
      }
      if (preflight.existingShare) {
        onShareChange(preflight.existingShare);
        setNotice(`Shared with ${organizationName}`);
        return;
      }
      const next = CollaborativeAppShareSchema.parse(await api.post(
        `/api/collaboration/apps/${encodeURIComponent(appId)}/share`,
        {
          organizationId,
          clientRequestId: crypto.randomUUID(),
          expectedResourceRevision: preflight.resourceRevision,
          expectedReadinessRevision: readiness.revision,
          readinessId: preflight.readinessId,
          buildId: preflight.buildId,
          confirmationToken: preflight.confirmationToken,
        },
      ));
      onShareChange(next);
      setNotice(`Shared with ${organizationName}`);
    } catch (error: unknown) {
      console.warn("[collaborative-app-share] create failed", error instanceof Error ? error.name : "UnknownError");
      setFailure("App sharing is unavailable. Try again.");
    } finally {
      setPending(false);
    }
  };

  const stop = async () => {
    if (!share) return;
    setPending(true); setFailure(null); setNotice(null);
    try {
      const next = CollaborativeAppShareSchema.parse(await api.delete(
        `/api/collaboration/apps/${encodeURIComponent(appId)}/share`,
        { clientRequestId: crypto.randomUUID(), expectedShareRevision: share.shareRevision,
          expectedBindingRevision: share.bindingRevision },
      ));
      onShareChange(next);
      setNotice("Sharing stopped");
    } catch (error: unknown) {
      console.warn("[collaborative-app-share] stop failed", error instanceof Error ? error.name : "UnknownError");
      setFailure("Sharing could not be stopped. Refresh and try again.");
    } finally {
      setPending(false);
    }
  };

  return <Dialog open onClose={onClose} aria-label={`Share ${name}`}>
    <div className="flex items-start justify-between gap-4">
      <div><p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Collaborative app</p>
        <h2 className="mt-1 text-xl font-semibold">Share {name}</h2></div>
      <button type="button" aria-label="Close" className="rounded-lg border px-2 py-1" onClick={onClose}>×</button>
    </div>
    <div className="mt-4"><ReadinessSummary readiness={readiness} /></div>
    <label className="mt-4 block text-sm font-medium">Organization
      <select aria-label="Organization" className="mt-1 w-full rounded-lg border bg-transparent px-3 py-2"
        value={organizationId} disabled>
        <option value={organizationId}>{organizationName}</option>
      </select>
    </label>
    <section className="mt-4 rounded-xl border p-4 text-sm">
      <h3 className="font-medium">{active ? `Shared with ${organizationName}` : `Everyone in ${organizationName}`}</h3>
      <p className="mt-2 text-[var(--text-secondary)]">Everyone currently in {organizationName}, including guests, gets full app access while they remain a member.</p>
      <p className="mt-2 text-[var(--text-secondary)]">The app stays owned by you. Stopping sharing removes organization access and does not delete or change your app data.</p>
    </section>
    {failure ? <p role="alert" className="mt-3 text-sm">{failure}</p> : null}
    {notice ? <p role="status" className="mt-3 text-sm">{notice}</p> : null}
    <div className="mt-5 flex justify-end gap-2">
      <button type="button" className="rounded-lg border px-3 py-2 text-sm" onClick={onClose}>Done</button>
      {active
        ? <button type="button" className="rounded-lg border px-3 py-2 text-sm" disabled={pending} onClick={() => void stop()}>{pending ? "Stopping…" : "Stop sharing"}</button>
        : <button type="button" className="rounded-lg border px-3 py-2 text-sm" disabled={pending || readiness.status !== "ready"} onClick={() => void create()}>{pending ? "Sharing…" : "Share with everyone"}</button>}
    </div>
  </Dialog>;
}

function displayName(appId: string): string {
  return appId.replaceAll(/[-_]+/g, " ").replace(/^./, (value) => value.toUpperCase());
}

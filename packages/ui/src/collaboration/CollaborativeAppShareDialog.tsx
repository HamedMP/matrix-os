import {
  type CollaborativeAppReadiness,
  type CollaborativeAppShare,
} from "@matrix-os/contracts";
import { useState } from "react";

import { Dialog } from "../Dialog.js";
import { ReadinessSummary } from "./ReadinessSummary.js";

export function CollaborativeAppShareDialog({
  appId,
  readiness,
  organizationId,
  organizationName,
  share,
  onCreate,
  onStop,
  stopEnabled,
  onClose,
}: {
  appId: string;
  readiness: CollaborativeAppReadiness | null;
  organizationId: string;
  organizationName: string;
  share: CollaborativeAppShare | null;
  onCreate(): Promise<CollaborativeAppShare | null>;
  onStop(): Promise<CollaborativeAppShare | null>;
  stopEnabled: boolean;
  onClose(): void;
}) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const active = share?.state === "active" || share?.state === "needs_recheck";
  const name = displayName(appId);

  const create = async () => {
    if (!readiness) return;
    setPending(true); setFailure(null); setNotice(null);
    try {
      const next = await onCreate();
      if (next) setNotice(`Shared with ${organizationName}`);
      else setFailure("App sharing is unavailable. Try again.");
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
      const next = await onStop();
      if (next) setNotice("Sharing stopped");
      else setFailure("Sharing could not be stopped. Refresh and try again.");
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
    {readiness ? <div className="mt-4"><ReadinessSummary readiness={readiness} /></div> : null}
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
        ? <button type="button" className="rounded-lg border px-3 py-2 text-sm" disabled={pending || !stopEnabled} onClick={() => void stop()}>{pending ? "Stopping…" : "Stop sharing"}</button>
        : <button type="button" className="rounded-lg border px-3 py-2 text-sm" disabled={pending || readiness?.status !== "ready"} onClick={() => void create()}>{pending ? "Sharing…" : "Share with everyone"}</button>}
    </div>
  </Dialog>;
}

function displayName(appId: string): string {
  return appId.replaceAll(/[-_]+/g, " ").replace(/^./, (value) => value.toUpperCase());
}

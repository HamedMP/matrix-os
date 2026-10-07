import {
  CollaborationProjectInventorySchema,
  CollaborationProjectTransitionSchema,
  CollaborationReadinessSchema,
  type CollaborationReadiness,
  type CollaborationProjectInventory,
  type CollaborationScope,
} from "@matrix-os/contracts";
import { useEffect, useRef, useState } from "react";
import { Dialog } from "../Dialog.js";
import type { CollaborationApi } from "./ChatCollaboratorsDialog.js";
import { ProjectSourceSummary } from "./ProjectSourceSummary.js";
import { ReadinessSummary } from "./ReadinessSummary.js";
import { ProjectAccessManager } from "./ProjectAccessManager.js";
import {
  deriveProjectPresentation,
  projectMembershipEffectKey,
  projectMembershipEffectLabel,
} from "./project-state.js";

const buttonClass = "rounded-lg border px-3 py-2 text-sm transition-colors hover:enabled:bg-[var(--bg-hover)] disabled:opacity-50";

export function ProjectSharingDialog({
  api,
  scope,
  projectName,
  organizationName,
  inventory,
  refreshInventory,
  onAccessChanged,
  onConfirmed,
  publicationDelayed = false,
  onCheckPublication,
  onClose,
}: {
  api: CollaborationApi;
  scope: CollaborationScope;
  projectName: string;
  organizationName?: string;
  inventory?: CollaborationProjectInventory;
  refreshInventory: () => Promise<CollaborationProjectInventory>;
  onAccessChanged?: () => Promise<unknown>;
  /** Called once the home accepts the confirmation; the project then publishes asynchronously. */
  onConfirmed?: () => void;
  /** True once the bounded wait for publication ran out; the share continues on the home. */
  publicationDelayed?: boolean;
  onCheckPublication?: () => void;
  onClose: () => void;
}) {
  const [currentInventory, setCurrentInventory] = useState<CollaborationProjectInventory | null>(() =>
    inventory ? CollaborationProjectInventorySchema.parse(inventory) : null,
  );
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const [readiness, setReadiness] = useState<CollaborationReadiness | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => api.post(`/api/collaboration/scopes/${encodeURIComponent(scope.id)}/policy/preflight`, {}))
      .then((value) => {
        const parsed = CollaborationReadinessSchema.safeParse(value);
        if (active && parsed.success && parsed.data.resourceKind === "project") setReadiness(parsed.data);
      })
      .catch((failure: unknown) => {
        console.warn("[project-collaboration] readiness unavailable", failure instanceof Error ? failure.name : "UnknownError");
      });
    return () => { active = false; };
  }, [api, scope.id]);
  const presentation = currentInventory ? deriveProjectPresentation(scope, currentInventory) : null;
  const chatRoots = (currentInventory?.ownedItems ?? []).filter((item) => item.kind === "chat").map((item) => ({
    chatId: item.id, ...(item.executionRoot ? { executionRoot: item.executionRoot } : {}),
    ...(item.branch ? { branch: item.branch } : {}), ...(item.dirty !== undefined ? { dirty: item.dirty } : {}),
    readiness: item.compatibility,
  }));

  const refreshAfterAccessChange = async () => {
    const result = await onAccessChanged?.();
    if (scope.lifecycle === "shared" || scope.lifecycle === "archived") return;
    const parsed = CollaborationProjectInventorySchema.safeParse(result);
    const refreshed = parsed.success
      ? parsed.data
      : CollaborationProjectInventorySchema.parse(await refreshInventory());
    if (alive.current) setCurrentInventory(refreshed);
  };

  const confirm = async () => {
    if (!presentation?.canConfirm || pending || confirmed || !currentInventory) return;
    setPending(true);
    setError("");
    setFeedback("");
    try {
      const result = CollaborationProjectTransitionSchema.parse(await api.post(
        `/api/collaboration/scopes/${scope.id}/project/confirm`,
        {
          clientRequestId: crypto.randomUUID(),
          expectedScopeRevision: currentInventory.scopeRevision,
          expectedProjectRevision: currentInventory.projectRevision,
          inventoryHash: currentInventory.inventoryHash,
          membershipHash: currentInventory.membershipHash,
          inventoryToken: currentInventory.inventoryToken,
        },
      ));
      if (alive.current) {
        setConfirmed(true);
        setFeedback(result.status === "active"
          ? "The whole project is shared."
          : "Preparing the shared project. Everyone gets access only after publication completes.");
        onConfirmed?.();
      }
    } catch (failure: unknown) {
      console.warn("[project-collaboration] confirmation failed", failure instanceof Error ? failure.name : "UnknownError");
      try {
        const refreshed = CollaborationProjectInventorySchema.parse(await refreshInventory());
        if (alive.current) {
          setCurrentInventory(refreshed);
          setError("Project contents changed. Review the complete updated inventory, then confirm again.");
        }
      } catch (refreshFailure: unknown) {
        console.warn("[project-collaboration] inventory refresh failed", refreshFailure instanceof Error ? refreshFailure.name : "UnknownError");
        if (alive.current) setError("Project sharing is unavailable. Refresh and try again.");
      }
    } finally {
      if (alive.current) setPending(false);
    }
  };

  const published = scope.lifecycle === "shared" || scope.lifecycle === "archived";
  return <Dialog open aria-label={`Share ${projectName}`} onClose={() => { if (!pending) onClose(); }}
    className="ph-no-capture flex max-h-[88vh] w-[min(94vw,560px)] flex-col gap-5 overflow-y-auto rounded-2xl border p-6"
    style={{
      background: "var(--bg-surface, var(--matrix-card, #FCFCF8))",
      color: "var(--text-primary, var(--matrix-card-fg, #32352E))",
      borderColor: "var(--border-default, var(--matrix-border, #D8D6C7))",
    }}>
    <header>
      <h2 className="text-lg font-semibold">{published ? `Share “${projectName}”` : `Share the whole ${projectName} project?`}</h2>
      <p className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>
        All current and future project contents share together, including every project Chat and its history.
        Files stay inside this access boundary, but collaborators do not get a file browser or editor yet.
      </p>
    </header>

    {scope.organizationId ? <ProjectAccessManager api={api} scope={scope}
      organizationName={organizationName}
      onChanged={refreshAfterAccessChange} /> : null}

    {currentInventory && !published ? <section aria-labelledby="project-contents-heading">
      <h3 id="project-contents-heading" className="font-medium">Complete project inventory</h3>
      <ul className="mt-2 grid gap-2 sm:grid-cols-2">
        {currentInventory.ownedItems.map((item) => <li key={`${item.kind}:${item.id}`}
          className="rounded-xl border px-3 py-2 text-sm">
          <span className="font-medium">{item.id}</span>
          <span className="ml-2 capitalize" style={{ color: "var(--text-secondary)" }}>{item.kind}</span>
        </li>)}
      </ul>
    </section> : null}

    {readiness && !published ? <ReadinessSummary readiness={readiness} /> : null}
    {currentInventory && !published ? <ProjectSourceSummary gitSetup={currentInventory.gitSetup} chatRoots={chatRoots} /> : null}

    {currentInventory && !published && currentInventory.externalReferences.length > 0 ? <section aria-labelledby="external-references-heading"
      className="rounded-xl border p-4">
      <h3 id="external-references-heading" className="font-medium">External references stay private</h3>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
        A linked item stays outside this project share unless it was independently shared.
      </p>
      <ul className="mt-2 grid gap-1 text-sm">
        {currentInventory.externalReferences.map((item) => <li key={`${item.kind}:${item.id}`}>{item.id}</li>)}
      </ul>
    </section> : null}

    {currentInventory && !published && currentInventory.membershipEffects.length > 0 ? <section aria-labelledby="membership-effects-heading">
      <h3 id="membership-effects-heading" className="font-medium">Membership changes</h3>
      <ul className="mt-2 grid gap-2">
        {currentInventory.membershipEffects.map((effect) => <li key={projectMembershipEffectKey(effect)}
          className="rounded-xl border px-3 py-2 text-sm">{projectMembershipEffectLabel(effect)}</li>)}
      </ul>
    </section> : null}

    {presentation && presentation.blockerMessages.length > 0 ? <div role="alert" className="rounded-xl border p-4 text-sm">
      {presentation.blockerMessages.map((message) => <p key={message}>{message}</p>)}
    </div> : null}
    {error ? <p role="alert" className="rounded-xl border p-3 text-sm">{error}</p> : null}
    {publicationDelayed
      ? <div role="status" className="flex items-center justify-between gap-3 rounded-xl border p-3 text-sm">
        <span>Sharing is taking longer than expected. It continues in the background; check again in a moment.</span>
        <button type="button" className={buttonClass} onClick={onCheckPublication}>Check again</button>
      </div>
      : feedback ? <p role="status" className="rounded-xl border p-3 text-sm">{feedback}</p> : null}

    <footer className="flex justify-end gap-2">
      <button type="button" className={buttonClass} disabled={pending} onClick={onClose}>{published ? "Done" : "Cancel"}</button>
      {!published ? <button type="button" className={buttonClass} disabled={pending || confirmed || !presentation?.canConfirm}
        onClick={() => void confirm()}>{pending ? "Confirming…" : confirmed ? "Publishing…" : "Share whole project"}</button> : null}
    </footer>
  </Dialog>;
}

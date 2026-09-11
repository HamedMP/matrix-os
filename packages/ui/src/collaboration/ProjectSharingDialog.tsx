import {
  CollaborationProjectInventorySchema,
  CollaborationProjectTransitionSchema,
  type CollaborationProjectInventory,
  type CollaborationScope,
} from "@matrix-os/contracts";
import { useEffect, useRef, useState } from "react";
import { Dialog } from "../Dialog.js";
import type { CollaborationApi } from "./ChatCollaboratorsDialog.js";
import {
  deriveProjectPresentation,
  projectMembershipEffectLabel,
} from "./project-state.js";

const buttonClass = "rounded-lg border px-3 py-2 text-sm transition-colors hover:enabled:bg-[var(--bg-hover)] disabled:opacity-50";

export function ProjectSharingDialog({
  api,
  scope,
  projectName,
  inventory,
  refreshInventory,
  onClose,
}: {
  api: CollaborationApi;
  scope: CollaborationScope;
  projectName: string;
  inventory: CollaborationProjectInventory;
  refreshInventory: () => Promise<CollaborationProjectInventory>;
  onClose: () => void;
}) {
  const [currentInventory, setCurrentInventory] = useState(() =>
    CollaborationProjectInventorySchema.parse(inventory),
  );
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const presentation = deriveProjectPresentation(scope, currentInventory);

  const confirm = async () => {
    if (!presentation.canConfirm || pending) return;
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
        setFeedback(result.status === "active"
          ? "The whole project is shared."
          : "Preparing the shared project. Everyone gets access only after publication completes.");
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

  return <Dialog open aria-label="Share whole project" onClose={() => { if (!pending) onClose(); }}
    className="ph-no-capture flex max-h-[88vh] w-[min(94vw,720px)] flex-col gap-5 overflow-y-auto rounded-2xl border p-6"
    style={{
      background: "var(--bg-surface, var(--matrix-card, #FCFCF8))",
      color: "var(--text-primary, var(--matrix-card-fg, #32352E))",
      borderColor: "var(--border-default, var(--matrix-border, #D8D6C7))",
    }}>
    <header>
      <h2 className="text-lg font-semibold">Share the whole {projectName} project?</h2>
      <p className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>
        Everything owned by this project shares together, including future project contents.
        You can't exclude individual files, Chats, apps, layout, or terminals.
      </p>
    </header>

    <section aria-labelledby="project-contents-heading">
      <h3 id="project-contents-heading" className="font-medium">Complete project inventory</h3>
      <ul className="mt-2 grid gap-2 sm:grid-cols-2">
        {currentInventory.ownedItems.map((item) => <li key={`${item.kind}:${item.id}`}
          className="rounded-xl border px-3 py-2 text-sm">
          <span className="font-medium">{item.id}</span>
          <span className="ml-2 capitalize" style={{ color: "var(--text-secondary)" }}>{item.kind}</span>
        </li>)}
      </ul>
    </section>

    {currentInventory.externalReferences.length > 0 ? <section aria-labelledby="external-references-heading"
      className="rounded-xl border p-4">
      <h3 id="external-references-heading" className="font-medium">External references stay private</h3>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
        A linked item stays outside this project share unless it was independently shared.
      </p>
      <ul className="mt-2 grid gap-1 text-sm">
        {currentInventory.externalReferences.map((item) => <li key={`${item.kind}:${item.id}`}>{item.id}</li>)}
      </ul>
    </section> : null}

    {currentInventory.membershipEffects.length > 0 ? <section aria-labelledby="membership-effects-heading">
      <h3 id="membership-effects-heading" className="font-medium">Membership changes</h3>
      <ul className="mt-2 grid gap-2">
        {currentInventory.membershipEffects.map((effect) => <li key={`${effect.actor.actorId}:${effect.effect}`}
          className="rounded-xl border px-3 py-2 text-sm">{projectMembershipEffectLabel(effect)}</li>)}
      </ul>
    </section> : null}

    {presentation.blockerMessages.length > 0 ? <div role="alert" className="rounded-xl border p-4 text-sm">
      {presentation.blockerMessages.map((message) => <p key={message}>{message}</p>)}
    </div> : null}
    {error ? <p role="alert" className="rounded-xl border p-3 text-sm">{error}</p> : null}
    {feedback ? <p role="status" className="rounded-xl border p-3 text-sm">{feedback}</p> : null}

    <footer className="flex justify-end gap-2">
      <button type="button" className={buttonClass} disabled={pending} onClick={onClose}>Cancel</button>
      <button type="button" className={buttonClass} disabled={pending || !presentation.canConfirm}
        onClick={() => void confirm()}>{pending ? "Confirming…" : "Share whole project"}</button>
    </footer>
  </Dialog>;
}

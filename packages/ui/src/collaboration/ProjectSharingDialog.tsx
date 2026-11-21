import {
  CollaborationProjectInventorySchema,
  CollaborationProjectTransitionSchema,
  type CollaborationProjectInventory,
  type CollaborationScope,
} from "@matrix-os/contracts";
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Dialog } from "../Dialog.js";
import type { CollaborationApi } from "./ChatCollaboratorsDialog.js";
import { ProjectSourceSummary } from "./ProjectSourceSummary.js";
import {
  deriveProjectPresentation,
} from "./project-state.js";

const buttonClass = "inline-flex h-7 items-center justify-center rounded-lg border px-2.5 text-xs font-medium transition-colors hover:enabled:bg-[var(--bg-hover)] disabled:opacity-50";

export function ProjectSharingDialog({
  api,
  scope,
  projectName,
  organizationName,
  inventory,
  refreshInventory,
  onConfirmed,
  publicationDelayed = false,
  publicationFailure,
  onCheckPublication,
  onClose,
}: {
  api: CollaborationApi;
  scope: CollaborationScope;
  projectName: string;
  organizationName?: string;
  inventory?: CollaborationProjectInventory;
  refreshInventory: () => Promise<CollaborationProjectInventory>;
  /** Called once the home accepts the confirmation; the project then publishes asynchronously. */
  onConfirmed?: () => void;
  /** True once the bounded wait for publication ran out; the share continues on the home. */
  publicationDelayed?: boolean;
  publicationFailure?: "inventory_changed" | "unavailable";
  onCheckPublication?: () => void;
  onClose: () => void;
}) {
  const [currentInventory, setCurrentInventory] = useState<CollaborationProjectInventory | null>(() =>
    inventory ? CollaborationProjectInventorySchema.parse(inventory) : null,
  );
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const displayedInventory = publicationFailure && inventory
    ? CollaborationProjectInventorySchema.parse(inventory)
    : currentInventory;
  const presentation = displayedInventory ? deriveProjectPresentation(scope, displayedInventory) : null;
  const chatRoots = (displayedInventory?.ownedItems ?? []).filter((item) => item.kind === "chat").map((item) => ({
    chatId: item.id, ...(item.executionRoot ? { executionRoot: item.executionRoot } : {}),
    ...(item.branch ? { branch: item.branch } : {}), ...(item.dirty !== undefined ? { dirty: item.dirty } : {}),
    readiness: item.compatibility,
  }));

  const confirm = async () => {
    if (!presentation?.canConfirm || pending || (confirmed && !publicationFailure) || !displayedInventory) return;
    const confirmationInventory = displayedInventory;
    if (confirmationInventory !== currentInventory) setCurrentInventory(confirmationInventory);
    setPending(true);
    setError("");
    setFeedback("");
    try {
      const result = CollaborationProjectTransitionSchema.parse(await api.post(
        `/api/collaboration/scopes/${scope.id}/project/confirm`,
        {
          clientRequestId: crypto.randomUUID(),
          expectedScopeRevision: confirmationInventory.scopeRevision,
          expectedProjectRevision: confirmationInventory.projectRevision,
          inventoryHash: confirmationInventory.inventoryHash,
          membershipHash: confirmationInventory.membershipHash,
          inventoryToken: confirmationInventory.inventoryToken,
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

  const unshare = async () => {
    if (pending || (scope.lifecycle !== "shared" && scope.lifecycle !== "archived")) return;
    setPending(true);
    setError("");
    try {
      await api.post(`/api/collaboration/scopes/${scope.id}/project/unshare`, {
        clientRequestId: crypto.randomUUID(),
        expectedRevision: scope.revision,
      });
      if (alive.current) onClose();
    } catch (failure: unknown) {
      console.warn("[project-collaboration] unshare failed", failure instanceof Error ? failure.name : "UnknownError");
      if (alive.current) setError("Project access could not be removed. Refresh and try again.");
    } finally {
      if (alive.current) setPending(false);
    }
  };

  const published = scope.lifecycle === "shared" || scope.lifecycle === "archived";
  const confirmationLocked = confirmed && !publicationFailure;
  const publicationError = publicationFailure === "inventory_changed"
    ? "Project contents changed while sharing. Review the complete updated inventory, then confirm again."
    : publicationFailure === "unavailable"
      ? "Sharing stopped before publication completed. Refresh the project inventory and try again."
      : "";
  return <Dialog open aria-label={`Share ${projectName}`} onClose={() => { if (!pending) onClose(); }}
    data-slot="project-share-dialog"
    className="ph-no-capture flex max-h-[88vh] w-[min(94vw,480px)] max-w-[480px] flex-col overflow-hidden rounded-[12px] border p-0"
    style={{
      background: "var(--bg-surface, var(--matrix-card, #fffefc))",
      color: "var(--text-primary, var(--matrix-card-fg, #32352E))",
      borderColor: "var(--border-subtle, var(--matrix-border, #ebeae6))",
      borderRadius: "12px",
      padding: 0,
      width: "min(94vw, 480px)",
      maxWidth: "480px",
      maxHeight: "88vh",
      overflowY: "hidden",
      boxShadow: "0 16px 40px rgba(36, 35, 35, 0.18)",
    }}>
    <header className="flex min-h-12 items-center gap-3 px-4 pt-1">
      <h2 className="min-w-0 flex-1 truncate text-sm font-medium">Share “{projectName}”</h2>
      <button type="button" aria-label="Close share dialog" disabled={pending}
        className="grid size-7 place-items-center rounded-md outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50"
        onClick={onClose}><X aria-hidden size={15} /></button>
    </header>

    <div className="min-h-0 flex-1 overflow-y-auto">
      {scope.organizationId ? <section aria-labelledby="project-access-heading" className="border-t px-4 py-3"
        style={{ borderColor: "var(--border-subtle, var(--border-default))" }}>
        <h3 id="project-access-heading" className="text-xs font-medium">Organization access</h3>
        <p className="mt-1 text-xs leading-5">
          Every active current and future member of {organizationName ?? "the organization"} can work in this project immediately.
        </p>
        <p className="mt-1 text-[10px] leading-4" style={{ color: "var(--text-secondary)" }}>
          AI work uses the owner&apos;s current Provider Settings and is billed to the owner. Members cannot change sharing, billing, or organization settings.
        </p>
      </section> : null}

      {!published ? <section className="border-t px-4 py-3" style={{ borderColor: "var(--border-subtle, var(--border-default))" }}>
        <p className="text-xs leading-5">
          All current and future project contents share together, including every project Chat and its history.
        </p>
        <p className="mt-0.5 text-[10px] leading-4" style={{ color: "var(--text-secondary)" }}>
          Members can use project Chats, files, apps, tools, and terminals inside this project boundary.
        </p>
      </section> : null}

      {displayedInventory && !published ? <section aria-labelledby="project-contents-heading" className="border-t px-4 py-3"
        style={{ borderColor: "var(--border-subtle, var(--border-default))" }}>
      <h3 id="project-contents-heading" className="text-[11px] font-medium" style={{ color: "var(--text-secondary)" }}>Complete project inventory</h3>
      <ul className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1">
        {displayedInventory.ownedItems.map((item) => <li key={`${item.kind}:${item.id}`}
          className="flex min-w-0 items-center gap-2 py-1 text-xs">
          <span className="min-w-0 flex-1 truncate font-medium">{item.id}</span>
          <span className="shrink-0 text-[10px] capitalize" style={{ color: "var(--text-secondary)" }}>{item.kind}</span>
        </li>)}
      </ul>
    </section> : null}

      {displayedInventory && !published ? <div className="border-t px-4 py-3" style={{ borderColor: "var(--border-subtle, var(--border-default))" }}>
        <ProjectSourceSummary gitSetup={displayedInventory.gitSetup} chatRoots={chatRoots} compact />
      </div> : null}

      {displayedInventory && !published && displayedInventory.externalReferences.length > 0 ? <section aria-labelledby="external-references-heading"
      className="border-t px-4 py-3" style={{ borderColor: "var(--border-subtle, var(--border-default))" }}>
      <h3 id="external-references-heading" className="text-xs font-medium">External references stay private</h3>
      <p className="mt-0.5 text-[10px] leading-4" style={{ color: "var(--text-secondary)" }}>
        A linked item stays outside this project share unless it was independently shared.
      </p>
      <ul className="mt-1 grid gap-1 text-xs">
        {displayedInventory.externalReferences.map((item) => <li key={`${item.kind}:${item.id}`}>{item.id}</li>)}
      </ul>
    </section> : null}

      {presentation && presentation.blockerMessages.length > 0 ? <div role="alert" className="mx-4 mb-3 rounded-lg border p-3 text-xs">
      {presentation.blockerMessages.map((message) => <p key={message}>{message}</p>)}
    </div> : null}
      {publicationError || error ? <p role="alert" className="mx-4 mb-3 rounded-lg border p-3 text-xs">{publicationError || error}</p> : null}
      {publicationDelayed
      ? <div role="status" className="mx-4 mb-3 flex items-center justify-between gap-3 rounded-lg border p-3 text-xs">
        <span>Sharing is taking longer than expected. It continues in the background; check again in a moment.</span>
        <button type="button" className={buttonClass} onClick={onCheckPublication}>Check again</button>
      </div>
      : feedback && !publicationFailure ? <p role="status" className="mx-4 mb-3 rounded-lg border p-3 text-xs">{feedback}</p> : null}
    </div>

    <footer className="flex items-end gap-3 border-t px-4 py-3" style={{ borderColor: "var(--border-subtle, var(--border-default))" }}>
      <p className="min-w-0 flex-1 text-[10px] leading-4" style={{ color: "var(--text-secondary)" }}>
        <span className="block">Files, apps, instructions, and project Chats share together.</span>
        <span className="block">Active organization members get access automatically.</span>
      </p>
      {published ? <>
        <button type="button" className={buttonClass} disabled={pending} onClick={() => void unshare()}>
          {pending ? "Removing…" : "Unshare project"}
        </button>
        <button type="button" className="h-7 rounded-lg bg-[var(--text-primary)] px-3 text-xs font-medium text-[var(--bg-surface)]"
          disabled={pending} onClick={onClose}>Done</button>
      </> : null}
      {!published ? <button type="button" className="h-7 rounded-lg bg-[var(--text-primary)] px-3 text-xs font-medium text-[var(--bg-surface)] disabled:opacity-50"
        disabled={pending || confirmationLocked || !presentation?.canConfirm}
        onClick={() => void confirm()}>{pending ? "Confirming…" : confirmationLocked ? "Publishing…" : "Share whole project"}</button> : null}
    </footer>
  </Dialog>;
}

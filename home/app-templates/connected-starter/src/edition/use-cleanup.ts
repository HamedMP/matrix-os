import { useCallback, useState } from "react";
import { parsePlan, parseReceipt } from "./transport";
import type { CleanupOperation, CleanupPlan, MailAction } from "./types";

interface Options {
  call(action: MailAction, payload: Record<string, unknown>): Promise<unknown>;
  performAction<T>(operation: () => Promise<T>): Promise<T | null>;
  offline: boolean;
  preview: boolean;
  notice(message: string): void;
}
/** Preview approval and submitted-operation recovery are separate states. */
export function useEditionCleanup(options: Options) {
  const [approval, setApproval] = useState<CleanupPlan | null>(null);
  const [operations, setOperations] = useState<CleanupOperation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const recover = useCallback((next: CleanupOperation[]) => {
    setOperations(next.filter((op) => op.receipt.state !== "undone"));
    setSelected((current) =>
      next.some(
        (op) => op.receipt.id === current && op.receipt.state !== "undone",
      )
        ? current
        : (next.find((op) => op.receipt.state !== "undone")?.receipt.id ??
          null),
    );
  }, []);
  const reset = useCallback(() => {
    setApproval(null);
    setOperations([]);
    setSelected(null);
  }, []);
  const operation = operations.find((op) => op.receipt.id === selected) ?? null;
  function confirmed(next: CleanupOperation) {
    setOperations((current) =>
      [next, ...current.filter((op) => op.receipt.id !== next.receipt.id)]
        .filter((op) => op.receipt.state !== "undone")
        .slice(0, 20),
    );
    setSelected(next.receipt.state === "undone" ? null : next.receipt.id);
  }
  async function cleanupPreview(messageIds: string[]) {
    if (options.offline || options.preview) return;
    await options.performAction(async () => {
      const next = parsePlan(
        await options.call("cleanup-preview", { messageIds }),
      );
      const selectedIds = new Set(messageIds);
      if (next.messageIds.some((id) => !selectedIds.has(id)))
        throw new Error("Cleanup selection changed");
      setApproval(next);
    });
  }
  async function cleanupCommit() {
    const plan = approval ?? operation?.plan;
    if (!plan || options.offline || options.preview) return;
    await options.performAction(async () => {
      // Expiration blocks fresh approval only. An existing submitted operation can be reconciled safely.
      if (approval && new Date(plan.expiresAt).getTime() <= Date.now())
        throw new Error("Cleanup plan expired");
      const receipt = parseReceipt(
        await options.call("cleanup-commit", {
          planId: plan.id,
          revision: plan.revision,
        }),
      );
      confirmed({ plan, receipt });
      setApproval(null);
      options.notice(
        receipt.state === "completed"
          ? `${receipt.archivedCount ?? 0} newsletters archived from your inbox.`
          : "Inbox cleanup is still being confirmed.",
      );
    });
  }
  async function undo() {
    if (!operation || options.offline || options.preview) return;
    await options.performAction(async () => {
      const receipt = parseReceipt(
        await options.call("cleanup-undo", {
          operationId: operation.receipt.id,
        }),
      );
      confirmed({ ...operation, receipt });
      options.notice(
        receipt.state === "undone"
          ? `${receipt.restoredCount ?? 0} newsletters restored to your inbox.`
          : "Inbox restoration is still being confirmed.",
      );
    });
  }
  return {
    approval,
    plan: operation?.plan ?? null,
    receipt: operation?.receipt ?? null,
    operations,
    recover,
    reset,
    selectCleanup: setSelected,
    cleanupPreview,
    cleanupCommit,
    cancelCleanup: () => setApproval(null),
    undo,
  };
}

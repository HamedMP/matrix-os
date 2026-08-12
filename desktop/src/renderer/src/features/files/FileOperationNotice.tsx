import { Button, Dialog } from "../../design/primitives";
import type { FileOperationSnapshot } from "./file-operation-controller";

export function FileOperationNotice({ snapshot, localNotice }: {
  snapshot: FileOperationSnapshot;
  localNotice?: string | null;
}) {
  const message = localNotice ?? safeOperationMessage(snapshot);
  if (!message) return null;
  return (
    <div role="status" className="border-b px-3 py-2 text-xs" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)", background: "var(--bg-raised)" }}>
      {message}
    </div>
  );
}

export function MoveToTrashDialog({ paths, pending, onCancel, onConfirm }: {
  paths: readonly string[];
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const count = paths.length;
  return (
    <Dialog open={count > 0} onClose={onCancel} width={380}>
      <div className="flex flex-col gap-3 p-4">
        <div>
          <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            Move {count === 1 ? "this item" : `${count} items`} to Trash?
          </h2>
          <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
            The selected {count === 1 ? "item" : "items"} will be moved to Trash.
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={pending} onClick={onCancel}>Cancel</Button>
          <Button variant="danger" disabled={pending} onClick={onConfirm}>Move to Trash</Button>
        </div>
      </div>
    </Dialog>
  );
}

function safeOperationMessage(snapshot: FileOperationSnapshot): string | null {
  if (snapshot.notice === "authoritative_reconciliation_required") return "The result could not be confirmed. Refresh before trying again.";
  if (snapshot.failures.some((failure) => failure.code === "protected")) return "Some selected items are protected and were not moved to Trash.";
  if (snapshot.failures.some((failure) => failure.code === "skipped")) return "Some selected items were skipped.";
  if (snapshot.failures.length > 0) return "Some selected items could not be changed.";
  if (snapshot.notice === "operation_unavailable") return "File actions are temporarily unavailable.";
  if (snapshot.notice === "request_mismatch" || snapshot.notice === "request_conflict") return "This file action is no longer valid. Refresh and try again.";
  if (snapshot.notice === "operation_failed") return "The file action could not be completed.";
  return null;
}

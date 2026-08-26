import { Button, Dialog } from "../../design/primitives";
export function DeleteConversationDialog({
  conversation,
  deleting,
  error,
  onCancel,
  onConfirm,
}: {
  conversation: { id: string; title: string } | null;
  deleting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={conversation !== null}
      onClose={onCancel}
      width={400}
      title={conversation ? `Delete ${conversation.title}?` : "Delete chat?"}
      role="alertdialog"
      placement="center"
    >
      {conversation ? (
        <div className="flex flex-col gap-4 p-5">
          <div>
            <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
              Delete {conversation.title}?
            </h2>
            <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
              This permanently deletes this chat and its messages. This action cannot be undone.
            </p>
          </div>
          {error ? (
            <p role="alert" className="rounded-lg px-3 py-2 text-sm" style={{ background: "var(--danger-muted)", color: "var(--danger)" }}>
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onCancel} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="danger" onClick={onConfirm} disabled={deleting}>
              {deleting ? "Deleting chat" : "Delete chat"}
            </Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

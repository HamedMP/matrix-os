import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import type { MemorySource, MemoryWorkspaceClient } from "./model.js";
import { safeMemoryMessage } from "./model.js";
export function MemoryEditor({
  source,
  client,
  onClose,
  onSaved,
}: {
  source: MemorySource | null;
  client: MemoryWorkspaceClient;
  onClose(): void;
  onSaved(source: MemorySource): Promise<void>;
}) {
  const [title, setTitle] = useState(source?.title ?? "");
  const [content, setContent] = useState(source?.content ?? "");
  const [collection, setCollection] = useState(source?.collection ?? "Notes");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestId] = useState(() => crypto.randomUUID());
  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = source
        ? await client.updateSource(source.id, {
            baseRevision: source.revision,
            title: title.trim(),
            content,
            collection: collection.trim(),
          })
        : (
            await client.importSources(
              [
                {
                  externalId: `note:${requestId}`,
                  title: title.trim(),
                  content,
                  collection: collection.trim(),
                  kind: "note",
                },
              ],
              requestId,
            )
          ).sources[0];
      if (!saved) throw new Error("empty_result");
      await onSaved(saved);
    } catch (failure) {
      setError(safeMemoryMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Overlay className="mw-dialog-backdrop" />
      <Dialog.Content
        className="mw-dialog"
        style={{
          position: "absolute",
          inset: "50% auto auto 50%",
          transform: "translate(-50%,-50%)",
          zIndex: 21,
        }}
      >
        <Dialog.Title>{source ? "Edit note" : "New note"}</Dialog.Title>
        <Dialog.Description className="mw-hint">
          Your original stays editable. Saving queues this revision for both
          memory engines.
        </Dialog.Description>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label>
            Title
            <input
              value={title}
              maxLength={300}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
              required
            />
          </label>
          <label>
            Collection
            <input
              value={collection}
              maxLength={200}
              onChange={(e) => setCollection(e.target.value)}
              required
            />
          </label>
          <label>
            Note content
            <textarea
              value={content}
              maxLength={200_000}
              onChange={(e) => setContent(e.target.value)}
              required
            />
          </label>
          {error && (
            <p role="alert" className="mw-alert">
              {error}
            </p>
          )}
          <div className="mw-dialog-footer">
            <button
              type="button"
              disabled={busy}
              className="mw-button"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              className="mw-button mw-button-primary"
              disabled={
                busy || !title.trim() || !content.trim() || !collection.trim()
              }
            >
              {busy ? "Saving…" : source ? "Save changes" : "Create note"}
            </button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

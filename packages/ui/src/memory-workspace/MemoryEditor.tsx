import { useRef, useState } from "react";
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
  const [committed, setCommitted] = useState(source);
  const committedRef = useRef(source);
  const savedChanges = useRef(
    source
      ? {
          title: source.title,
          content: source.content,
          collection: source.collection,
        }
      : null,
  );
  const creation = useRef<{
    title: string;
    content: string;
    collection: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestId] = useState(() => crypto.randomUUID());
  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const changes = {
        title: title.trim(),
        content,
        collection: collection.trim(),
      };
      let saved = committedRef.current;
      if (!saved) {
        // An uncertain creation is retried with exactly the original receipt payload.
        creation.current ??= changes;
        const created = (
          await client.importSources(
            [
              {
                externalId: `note:${requestId}`,
                ...creation.current,
                kind: "note",
              },
            ],
            requestId,
          )
        ).sources[0];
        if (!created) throw new Error("empty_result");
        saved = created;
        committedRef.current = saved;
        savedChanges.current = creation.current;
        setCommitted(saved);
      }
      if (JSON.stringify(changes) !== JSON.stringify(savedChanges.current)) {
        saved = await client.updateSource(saved.id, {
          baseRevision: saved.revision,
          ...changes,
        });
        committedRef.current = saved;
        savedChanges.current = changes;
        setCommitted(saved);
      }
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
        <Dialog.Title>{committed ? "Edit note" : "New note"}</Dialog.Title>
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
              disabled={busy}
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
              disabled={busy}
              value={collection}
              maxLength={200}
              onChange={(e) => setCollection(e.target.value)}
              required
            />
          </label>
          <label>
            Note content
            <textarea
              disabled={busy}
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
              {busy ? "Saving…" : committed ? "Save changes" : "Create note"}
            </button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

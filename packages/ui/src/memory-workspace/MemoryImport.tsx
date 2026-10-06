import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { SHELL_Z_INDEX } from "../shell-layering.js";
import { z } from "zod/v4";
import {
  parseMemoryImportBatch,
  memoryImportRequestId,
  safeMemoryMessage,
  type MemoryImportSource,
  type MemoryWorkspaceClient,
} from "./model.js";
import { MemoryIcon } from "./MemoryIcon.js";
export type MemoryNativeImportAdapter = {
  invoke(command: string, payload: unknown): Promise<unknown>;
};
const nativeResult = z.object({
  status: z.string(),
  collections: z
    .array(z.object({ id: z.string(), label: z.string() }))
    .max(500)
    .optional(),
  selectionId: z.string().optional(),
  records: z
    .array(
      z.object({
        externalId: z.string(),
        title: z.string(),
        content: z.string(),
        kind: z.enum(["note", "email", "calendar", "document"]),
        collection: z.string(),
        occurredAt: z.string().optional(),
        restoreDeleted: z.boolean().optional(),
        metadata: z.record(z.string(), z.string()).optional(),
      }),
    )
    .max(100)
    .optional(),
  warnings: z.array(z.string().max(500)).max(20).optional(),
});
export function MemoryImport({
  client,
  native,
  onClose,
  onImported,
}: {
  client: MemoryWorkspaceClient;
  native?: MemoryNativeImportAdapter;
  onClose(): void;
  onImported(): Promise<void>;
}) {
  const [intentId] = useState(() => crypto.randomUUID());
  const [records, setRecords] = useState<MemoryImportSource[]>([]);
  const [included, setIncluded] = useState<string[]>([]);
  const [collections, setCollections] = useState<
    { id: string; label: string }[]
  >([]);
  const [selectedCollections, setSelectedCollections] = useState<string[]>([]);
  const [provider, setProvider] = useState<
    "notes" | "mail" | "calendar" | null
  >(null);
  const [selectionId, setSelectionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const confirmedBatch = useRef<MemoryImportSource[] | null>(null);
  const [batchLocked, setBatchLocked] = useState(false);
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      if (live.current) setError(safeMemoryMessage(failure));
    } finally {
      if (live.current) setBusy(false);
    }
  }
  function preview(next: MemoryImportSource[]) {
    confirmedBatch.current = null;
    setBatchLocked(false);
    setRecords(next);
    setIncluded(next.map((record) => record.externalId));
  }
  async function inventory(next: "notes" | "mail" | "calendar") {
    await run(async () => {
      if (!native) return;
      const result = nativeResult.parse(
        await native.invoke("memory:import-inventory", { provider: next }),
      );
      if (result.status !== "ready") throw new Error("native_access_failed");
      setProvider(next);
      setCollections(result.collections ?? []);
      setSelectedCollections([]);
      setWarnings(result.warnings ?? []);
    });
  }
  async function nativePreview() {
    await run(async () => {
      if (!native || !provider) return;
      const result = nativeResult.parse(
        await native.invoke("memory:import-preview", {
          provider,
          collectionIds: selectedCollections,
          limit: 100,
        }),
      );
      if (result.status !== "preview" || !result.selectionId)
        throw new Error("preview_failed");
      setSelectionId(result.selectionId);
      setWarnings(result.warnings ?? []);
      preview(result.records ?? []);
    });
  }
  async function nativeFile() {
    await run(async () => {
      if (!native) return;
      const result = nativeResult.parse(
        await native.invoke("memory:import-file", {}),
      );
      if (result.status === "cancelled") return;
      if (result.status !== "preview" || !result.selectionId)
        throw new Error("preview_failed");
      setSelectionId(result.selectionId);
      setProvider(null);
      setWarnings(result.warnings ?? []);
      preview(result.records ?? []);
    });
  }
  async function confirm() {
    await run(async () => {
      let selected =
        confirmedBatch.current ??
        records.filter((record) => included.includes(record.externalId));
      if (!confirmedBatch.current && selectionId && native) {
        const result = nativeResult.parse(
          await native.invoke("memory:import-confirm", {
            selectionId,
            externalIds: included,
          }),
        );
        if (result.status !== "confirmed") throw new Error("confirm_failed");
        selected = (result.records ?? []).filter((record) =>
          included.includes(record.externalId),
        );
      }
      if (!selected.length) throw new Error("empty_import");
      if (!live.current) return;
      confirmedBatch.current = selected;
      setBatchLocked(true);
      setSelectionId(null);
      const receipt = await client.importSources(
        selected,
        memoryImportRequestId(selected, intentId),
      );
      if (receipt.sources.length !== selected.length)
        throw new Error("incomplete_import_receipt");
      if (live.current) await onImported();
    });
  }
  async function loadFile(file: File) {
    await run(async () => {
      if (file.size > 1_000_000) throw new Error("import_too_large");
      const batch = parseMemoryImportBatch(file.name, await file.text());
      if (!live.current) return;
      preview(batch.records);
      setSelectionId(null);
      setProvider(null);
      setWarnings(batch.warnings);
    });
  }
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Overlay
        className="mw-dialog-backdrop"
        style={{ zIndex: SHELL_Z_INDEX.appDialog }}
      />
      <Dialog.Content
        className="mw-dialog"
        style={{
          position: "absolute",
          inset: "50% auto auto 50%",
          transform: "translate(-50%,-50%)",
          zIndex: SHELL_Z_INDEX.appDialog,
        }}
      >
        <Dialog.Title>Bring your knowledge together</Dialog.Title>
        <Dialog.Description className="mw-hint">
          Choose what to import, review the originals, then send the same
          sources to both engines. Storage stays on your computer’s VPS. Cloud
          models may process the selected text.
        </Dialog.Description>
        {records.length === 0 ? (
          <>
            <div className="mw-import-choices">
              {(["notes", "mail", "calendar"] as const).map((value) => (
                <button
                  type="button"
                  key={value}
                  className="mw-import-choice"
                  disabled={!native || busy}
                  onClick={() => void inventory(value)}
                >
                  <MemoryIcon
                    name={
                      value === "notes"
                        ? "note"
                        : value === "mail"
                          ? "email"
                          : "calendar"
                    }
                    size={24}
                  />
                  {value === "notes"
                    ? "Apple Notes"
                    : value === "mail"
                      ? "Mail"
                      : "Calendar"}
                </button>
              ))}
            </div>
            {!native && (
              <p className="mw-hint">
                Direct Apple imports are available in the Matrix desktop app.
                You can import exported sources here.
              </p>
            )}
            {provider && (
              <fieldset style={{ border: 0, padding: 0 }}>
                <legend className="mw-hint">
                  Choose{" "}
                  {provider === "notes"
                    ? "folders"
                    : provider === "mail"
                      ? "mailboxes"
                      : "calendars"}{" "}
                  to preview
                </legend>
                {collections.map((collection) => (
                  <label
                    key={collection.id}
                    style={{
                      display: "flex",
                      gap: 10,
                      alignItems: "center",
                      marginTop: 8,
                    }}
                  >
                    <input
                      type="checkbox"
                      disabled={busy || batchLocked}
                      style={{ width: 16, margin: 0 }}
                      checked={selectedCollections.includes(collection.id)}
                      onChange={(e) =>
                        setSelectedCollections((current) =>
                          e.target.checked
                            ? [...current, collection.id]
                            : current.filter((id) => id !== collection.id),
                        )
                      }
                    />
                    {collection.label}
                  </label>
                ))}
                {!collections.length && (
                  <p className="mw-hint">
                    No available collections. Check access in the source app or
                    use an export.
                  </p>
                )}
                <button
                  className="mw-button"
                  disabled={
                    busy ||
                    !selectedCollections.length ||
                    selectedCollections.length > 10
                  }
                  onClick={() => void nativePreview()}
                >
                  Preview selected sources
                </button>
              </fieldset>
            )}
            <input
              ref={fileRef}
              type="file"
              accept=".json,.md,.txt"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void loadFile(file);
                e.target.value = "";
              }}
            />
            <button
              className="mw-button"
              style={{ width: "100%", marginTop: 20 }}
              disabled={busy}
              onClick={() =>
                native ? void nativeFile() : fileRef.current?.click()
              }
            >
              <MemoryIcon name="upload" />
              Import an export
            </button>
            <p className="mw-hint">
              {native
                ? "Markdown, text, JSON, email (.eml) or calendar (.ics) exports · up to 100 sources."
                : "Markdown, plain text, or a JSON source export · up to 1 MB and 100 sources per import."}
            </p>
          </>
        ) : (
          <>
            <div className="mw-eyebrow">
              {included.length} of {records.length} sources selected
            </div>
            <div className="mw-preview">
              {records.map((record, index) => (
                <label
                  className="mw-preview-item"
                  key={`${record.externalId}:${index}`}
                  style={{ display: "block", margin: 0 }}
                >
                  <span
                    style={{ display: "flex", alignItems: "center", gap: 10 }}
                  >
                    <input
                      type="checkbox"
                      disabled={busy || batchLocked}
                      style={{ width: 16, margin: 0 }}
                      checked={included.includes(record.externalId)}
                      onChange={(e) =>
                        setIncluded((current) =>
                          e.target.checked
                            ? [...current, record.externalId]
                            : current.filter((id) => id !== record.externalId),
                        )
                      }
                    />
                    <strong>{record.title}</strong>
                  </span>
                  <p>
                    {record.collection} · {record.kind}
                    {record.occurredAt
                      ? ` · ${record.occurredAt.slice(0, 10)}`
                      : ""}
                  </p>
                  <p>{record.content.slice(0, 400)}</p>
                </label>
              ))}
            </div>
          </>
        )}
        {warnings.map((warning, index) => (
          <p className="mw-hint" key={index}>
            {warning}
          </p>
        ))}
        {error && (
          <p role="alert" className="mw-alert">
            {error}
          </p>
        )}
        <div className="mw-dialog-footer">
          <button className="mw-button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          {records.length > 0 && (
            <>
              <button
                className="mw-button"
                disabled={busy}
                onClick={() => {
                  setRecords([]);
                  setSelectionId(null);
                }}
              >
                Back
              </button>
              <button
                className="mw-button mw-button-primary"
                disabled={busy || !included.length}
                onClick={() => void confirm()}
              >
                {busy ? "Importing…" : `Import ${included.length} sources`}
              </button>
            </>
          )}
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}

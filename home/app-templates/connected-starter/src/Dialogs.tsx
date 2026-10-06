import { useState } from "react";
import { RecordConflictError } from "./persistence";
import Sheet from "./Sheet";
export { ImportDialog } from "./ImportDialog";
import { safeUrl, validateFields } from "./model";
import type { Definition, OwnerRecord } from "./types";
export function Editor({
  app,
  record,
  onSave,
  onArchive,
  onClose,
}: {
  app: Definition;
  record?: OwnerRecord;
  onSave: (r: OwnerRecord) => Promise<unknown>;
  onArchive: (r: OwnerRecord) => Promise<unknown>;
  onClose: () => void;
}) {
  const [draftId] = useState(() => record?.id ?? crypto.randomUUID());
  const [fields, setFields] = useState<OwnerRecord["fields"]>(
      record?.fields ?? {},
    ),
    [scope, setScope] = useState<"personal" | "work">(
      record?.scope ?? (app.collection === "business" ? "work" : "personal"),
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errors = validateFields(app, fields);
    if (errors.length) {
      setError(errors.join(". "));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onSave({
        ...record,
        id: draftId,
        fields,
        scope,
        accounts: record?.accounts ?? [],
        sources: record?.sources ?? [],
        manualFields: Array.from(
          new Set([
            ...(record?.manualFields ?? []),
            ...app.fields
              .filter((f) => fields[f.key] !== record?.fields[f.key])
              .map((f) => f.key),
          ]),
        ),
        updatedAt: new Date().toISOString(),
      });
      onClose();
    } catch (cause) {
      console.error("Editor save failed", cause);
      setError(
        cause instanceof RecordConflictError
          ? cause.message
          : "Save failed. Your changes are still here.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function archive() {
    if (!record) return;
    setBusy(true);
    try {
      await onArchive(record);
      onClose();
    } catch (cause) {
      console.error("Editor archive failed", cause);
      setError(
        cause instanceof RecordConflictError
          ? cause.message
          : "Archive failed. Record is still here.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      title={`${record ? "Edit" : "Add"} ${app.entity}`}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form onSubmit={(e) => void submit(e)} className="editor">
        <p className="muted">
          Your changes are saved on your computer. Original evidence stays
          attached.
        </p>
        {app.fields.map((field) => (
          <label key={field.key}>
            <span>
              {field.label}
              {field.required ? " *" : ""}
            </span>
            {field.kind === "longtext" ? (
              <textarea
                rows={5}
                maxLength={12000}
                value={fields[field.key] ?? ""}
                onChange={(e) =>
                  setFields({ ...fields, [field.key]: e.target.value || null })
                }
              />
            ) : field.kind === "select" ? (
              <select
                value={fields[field.key] ?? ""}
                onChange={(e) =>
                  setFields({ ...fields, [field.key]: e.target.value || null })
                }
              >
                <option value="">Unknown / not set</option>
                {field.options?.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            ) : (
              <input
                type={
                  field.kind === "date"
                    ? "date"
                    : field.kind === "number" || field.kind === "money"
                      ? "number"
                      : field.kind === "url"
                        ? "url"
                        : "text"
                }
                min={
                  field.kind === "money" || field.key === "minutes"
                    ? 0
                    : undefined
                }
                step="any"
                maxLength={1000}
                value={fields[field.key] ?? ""}
                placeholder={
                  field.key === "currency"
                    ? "Three-letter code, e.g. USD"
                    : undefined
                }
                onChange={(e) =>
                  setFields({
                    ...fields,
                    [field.key]:
                      e.target.value === ""
                        ? null
                        : field.kind === "number" || field.kind === "money"
                          ? Number(e.target.value)
                          : field.key === "currency"
                            ? e.target.value.toUpperCase()
                            : e.target.value,
                  })
                }
              />
            )}
          </label>
        ))}
        <label>
          <span>Record group</span>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as "personal" | "work")}
          >
            <option value="personal">Personal</option>
            <option value="work">Work</option>
          </select>
        </label>
        {error && (
          <p role="alert" className="notice error">
            {error}
          </p>
        )}
        <div className="sheet-actions">
          {record && (
            <button
              type="button"
              onClick={() => void archive()}
              disabled={busy}
            >
              Archive record
            </button>
          )}
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Saving…" : "Save record"}
          </button>
        </div>
      </form>
    </Sheet>
  );
}
export function EvidenceDrawer({
  record,
  onClose,
}: {
  record: OwnerRecord;
  onClose: () => void;
}) {
  return (
    <Sheet title="Original evidence" onClose={onClose}>
      <p className="muted">
        {String(record.fields.title ?? "Record")} · {record.sources.length}{" "}
        sources
      </p>
      {record.sources.length ? (
        record.sources.map((source) => (
          <article
            className="evidence"
            key={JSON.stringify([source.service, source.label, source.id])}
          >
            <span className="eyebrow">
              {source.service} · {source.label}
            </span>
            <h3>{source.title}</h3>
            {source.date && <p className="muted">{source.date}</p>}
            {source.excerpt && <p>{source.excerpt}</p>}
            {safeUrl(source.url) && (
              <a href={safeUrl(source.url)} target="_blank" rel="noreferrer">
                Open original ↗
              </a>
            )}
            <code>Source {source.id}</code>
          </article>
        ))
      ) : (
        <div className="quiet-empty">
          This record was added manually. There are no imported sources.
        </div>
      )}
    </Sheet>
  );
}

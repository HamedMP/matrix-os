import { useRef, useState } from "react";
import { RecordConflictError } from "./persistence";
import Sheet from "./Sheet";
export { ImportDialog } from "./ImportDialog";
import { safeUrl, validateFields } from "./model";
import type { Definition, OwnerRecord } from "./types";
export function Editor({
  app,
  record,
  creationScope,
  onSave,
  onArchive,
  onClose,
  onLoadLatest,
}: {
  app: Definition;
  record?: OwnerRecord;
  creationScope?: "personal" | "work";
  onSave: (r: OwnerRecord) => Promise<unknown>;
  onArchive: (r: OwnerRecord) => Promise<unknown>;
  onClose: () => void;
  onLoadLatest?: () => Promise<OwnerRecord | null>;
}) {
  const baseline = useRef(record);
  const [conflict, setConflict] = useState(false), [latest, setLatest] = useState<OwnerRecord | null>(null);
  const [draftId] = useState(() => record?.id ?? crypto.randomUUID());
  const [fields, setFields] = useState<OwnerRecord["fields"]>(
      record?.fields ?? {},
    ),
    [scope, setScope] = useState<"personal" | "work">(
      record?.scope ?? creationScope ?? (app.collection === "business" ? "work" : "personal"),
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || conflict) return;
    const errors = validateFields(app, fields);
    if (errors.length) {
      setError(errors.join(". "));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onSave({
        ...baseline.current,
        id: draftId,
        fields,
        scope,
        accounts: baseline.current?.accounts ?? [],
        sources: baseline.current?.sources ?? [],
        manualFields: Array.from(
          new Set([
            ...(baseline.current?.manualFields ?? []),
            ...app.fields
              .filter((f) => fields[f.key] !== baseline.current?.fields[f.key])
              .map((f) => f.key),
          ]),
        ),
        updatedAt: new Date().toISOString(),
      });
      onClose();
    } catch (cause) {
      console.error("Editor save failed", cause);
      if (cause instanceof RecordConflictError) { setConflict(true); setLatest(null); }
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
    if (!baseline.current || busy || conflict) return;
    setBusy(true);
    try {
      await onArchive(baseline.current);
      onClose();
    } catch (cause) {
      console.error("Editor archive failed", cause);
      if (cause instanceof RecordConflictError) { setConflict(true); setLatest(null); }
      setError(
        cause instanceof RecordConflictError
          ? cause.message
          : "Archive failed. Record is still here.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function reviewLatest() {
    if (busy || !onLoadLatest) return;
    setBusy(true); setLatest(null);
    try {
      const current = await onLoadLatest();
      if (!current || current.id !== draftId || current.archivedAt || !current.rowId || !current.basePayload)
        throw new Error("Current record unavailable");
      setLatest(current);
    } catch (cause) {
      console.error("Editor conflict review failed", cause);
      setError("The latest record is unavailable. Your draft is still here. Try again.");
    } finally { setBusy(false); }
  }
  function reapply() {
    if (!latest || busy) return;
    const changed = Object.fromEntries(app.fields.filter(field => fields[field.key] !== baseline.current?.fields[field.key])
      .map(field => [field.key, fields[field.key]]));
    setFields({ ...latest.fields, ...changed });
    if (scope === baseline.current?.scope) setScope(latest.scope);
    baseline.current = latest; setLatest(null); setConflict(false); setError("");
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
                disabled={busy}
                rows={5}
                maxLength={12000}
                value={fields[field.key] ?? ""}
                onChange={(e) =>
                  setFields({ ...fields, [field.key]: e.target.value || null })
                }
              />
            ) : field.kind === "select" ? (
              <select
                disabled={busy}
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
                disabled={busy}
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
            disabled={busy}
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
        {conflict && <section aria-label="Review latest record">
          <p>Your draft is kept here. Review the current record before reapplying your changes.</p>
          <button type="button" onClick={() => void reviewLatest()} disabled={busy || !onLoadLatest}>Review latest record</button>
          {latest && <>
            <h3>Latest saved values</h3>
            <dl>{app.fields.map(field => <div key={field.key}><dt>{field.label}</dt><dd>{String(latest.fields[field.key] ?? "Not set")}</dd></div>)}
              <div><dt>Record group</dt><dd>{latest.scope === "work" ? "Work" : "Personal"}</dd></div>
            </dl>
            <button type="button" onClick={reapply} disabled={busy}>Reapply my changes to this version</button>
          </>}
        </section>}
        <div className="sheet-actions">
          {record && (
            <button
              type="button"
              onClick={() => void archive()}
              disabled={busy || conflict}
            >
              Archive record
            </button>
          )}
          <button type="submit" className="primary" disabled={busy || conflict}>
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

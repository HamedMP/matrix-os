import { useEffect, useMemo, useState } from "react";
import { importPrompt } from "./import";
import { safeUrl, validateFields } from "./model";
import type { Connection, Definition, OwnerRecord } from "./types";
function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="backdrop" onClick={onClose}>
      <section
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Tab") {
            const items = Array.from(
              e.currentTarget.querySelectorAll<HTMLElement>(
                "button:not(:disabled),input,textarea,select,a[href]",
              ),
            );
            const first = items[0],
              last = items[items.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last?.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header>
          <h2>{title}</h2>
          <button autoFocus aria-label="Close dialog" onClick={onClose}>
            ×
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
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
      setError("Save failed. Your changes are still here.");
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
      setError("Archive failed. Record is still here.");
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
export function ImportDialog({
  app,
  onClose,
}: {
  app: Definition;
  onClose: () => void;
}) {
  const [inventory, setInventory] = useState<Connection[] | null>(null),
    [loaded, setLoaded] = useState(false),
    [chosen, setChosen] = useState<string[]>([]),
    [start, setStart] = useState(() =>
      new Date(new Date().getFullYear(), 0, 1).toLocaleDateString("en-CA"),
    ),
    [end, setEnd] = useState(() => new Date().toLocaleDateString("en-CA")),
    [context, setContext] = useState(""),
    [scope, setScope] = useState<"personal" | "work">(
      app.collection === "business" ? "work" : "personal",
    ),
    [error, setError] = useState(""),
    [sent, setSent] = useState(false);
  const selectedKeys = useMemo(() => new Set(chosen), [chosen]);
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        if (!window.MatrixOS?.integrations)
          throw new Error("Connections unavailable");
        const data = await window.MatrixOS.integrations();
        if (!Array.isArray(data)) throw new Error("Invalid connections");
        if (alive)
          setInventory(
            data
              .filter(
                (c) =>
                  typeof c.service === "string" &&
                  typeof c.account_label === "string" &&
                  c.account_label.length <= 200 &&
                  c.status === "active",
              )
              .slice(0, 100),
          );
      } catch (cause) {
        console.error("Connection inventory failed", cause);
        if (alive) setInventory(null);
      } finally {
        if (alive) setLoaded(true);
      }
    }
    void load();
    return () => {
      alive = false;
    };
  }, []);
  function request() {
    try {
      if (!window.MatrixOS?.generate || inventory === null)
        throw new Error(
          "Import is unavailable. Check connections and try again.",
        );
      const accounts = inventory
        .filter((c) => selectedKeys.has(`${c.service}:${c.account_label}`))
        .map((c) => ({ service: c.service, label: c.account_label }));
      const prompt = importPrompt(
        app,
        { accounts, start, end, context, scope },
        inventory,
      );
      window.MatrixOS.generate(prompt);
      setSent(true);
      setError("");
    } catch (cause) {
      console.error("Import request failed", cause);
      setError(
        cause instanceof Error && /^Choose/.test(cause.message)
          ? cause.message
          : "Import could not be requested. Check your connections and try again.",
      );
    }
  }
  return (
    <Sheet title={`Connect ${app.name}`} onClose={onClose}>
      {sent ? (
        <div className="request-sent">
          <span className="orb">↗</span>
          <h3>Request sent to Matrix</h3>
          <p>
            Matrix will review your selected sources and save supported records.
            Return to this app and choose <strong>Check records</strong> to see
            what was added.
          </p>
          <p className="muted">No import has been confirmed yet.</p>
          <button className="primary" onClick={onClose}>
            Back to records
          </button>
        </div>
      ) : (
        <div className="editor">
          <p className="muted">
            Choose exactly which accounts Matrix can read. It will keep the
            original evidence and preserve your edits.
          </p>
          {!loaded ? (
            <p>Checking connections…</p>
          ) : inventory === null ? (
            <p className="notice">
              Connection availability could not be checked.
            </p>
          ) : (
            app.services.map((service) => {
              const accounts = inventory.filter(
                (c) => c.service === service.id,
              );
              return (
                <fieldset key={service.id}>
                  <legend>{service.name}</legend>
                  {accounts.length ? (
                    accounts.map((account) => {
                      const key = `${account.service}:${account.account_label}`;
                      return (
                        <label className="check" key={key}>
                          <input
                            type="checkbox"
                            checked={selectedKeys.has(key)}
                            onChange={(e) =>
                              setChosen(
                                e.target.checked
                                  ? [...chosen, key]
                                  : chosen.filter((k) => k !== key),
                              )
                            }
                          />
                          <span>
                            {account.account_label}
                            <small>
                              {account.account_email ?? "Connected account"}
                            </small>
                          </span>
                        </label>
                      );
                    })
                  ) : (
                    <p className="muted">
                      Connect this service in Matrix Settings first.
                    </p>
                  )}
                </fieldset>
              );
            })
          )}
          <div className="date-fields">
            <label>
              <span>From</span>
              <input
                type="date"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </label>
            <label>
              <span>Through</span>
              <input
                type="date"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </label>
          </div>
          <label>
            <span>Repository, project, channel or source context</span>
            <textarea
              value={context}
              rows={3}
              maxLength={2000}
              onChange={(e) => setContext(e.target.value)}
              placeholder="Be specific about which sources to include"
            />
          </label>
          <label>
            <span>Imported record group</span>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as "personal" | "work")}
            >
              <option value="personal">Personal</option>
              <option value="work">Work</option>
            </select>
          </label>
          <p className="fine-print">
            Read-only access. Matrix will use supported actions only, leave
            unknown facts empty, and report incomplete coverage.
          </p>
          {error && (
            <p role="alert" className="notice error">
              {error}
            </p>
          )}
          <button
            className="primary"
            disabled={!loaded || inventory === null}
            onClick={request}
          >
            Ask Matrix to import
          </button>
        </div>
      )}
    </Sheet>
  );
}

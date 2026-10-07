import { dateText, safeUrl } from "../model";
import type { Definition, OwnerRecord } from "../types";
export interface ViewProps {
  app: Definition;
  records: OwnerRecord[];
  creationScope?: "personal" | "work";
  onEdit: (record: OwnerRecord) => void;
  onEvidence: (record: OwnerRecord) => void;
  onAdd: () => void;
  onSave: (record: OwnerRecord) => Promise<unknown>;
}
export function Badge({ value }: { value: unknown }) {
  return value ? (
    <span
      className={`badge ${["Paid", "Succeeded", "Done", "Shipped", "Confirmed"].includes(String(value)) ? "settled" : ""}`}
    >
      {String(value)}
    </span>
  ) : (
    <span className="badge">Not set</span>
  );
}
export function Actions({
  record,
  onEdit,
  onEvidence,
}: Pick<ViewProps, "onEdit" | "onEvidence"> & { record: OwnerRecord }) {
  return (
    <div className="record-actions">
      <button onClick={() => onEdit(record)}>Edit</button>
      <button onClick={() => onEvidence(record)}>
        {record.sources.length
          ? `${record.sources.length} sources`
          : "Manual entry"}
      </button>
    </div>
  );
}
export function Card({
  record,
  app,
  onEdit,
  onEvidence,
}: Pick<ViewProps, "app" | "onEdit" | "onEvidence"> & { record: OwnerRecord }) {
  return (
    <article className="record-card">
      <div className="card-top">
        <Badge value={record.fields.status} />
        <span className="muted">
          {record.scope === "work" ? "Work" : "Personal"}
        </span>
      </div>
      <h3>{String(record.fields.title ?? "Untitled")}</h3>
      {app.fields
        .filter(
          (f) =>
            !["title", "status", "notes", "url"].includes(f.key) &&
            record.fields[f.key] != null &&
            record.fields[f.key] !== "",
        )
        .slice(0, 5)
        .map((f) => (
          <p key={f.key} className="record-fact">
            <span>{f.label}</span>
            <strong>
              {f.kind === "date"
                ? dateText(record.fields[f.key])
                : String(record.fields[f.key])}
            </strong>
          </p>
        ))}
      {record.fields.notes && (
        <p className="note-excerpt">
          {String(record.fields.notes).slice(0, 240)}
        </p>
      )}
      {safeUrl(record.fields.url) && (
        <a
          className="original-link"
          href={safeUrl(record.fields.url)}
          target="_blank"
          rel="noreferrer"
        >
          Open link ↗
        </a>
      )}
      <Actions record={record} onEdit={onEdit} onEvidence={onEvidence} />
    </article>
  );
}
export function Empty({ app, onAdd }: { app: Definition; onAdd: () => void }) {
  return (
    <div className={`empty-state empty-${app.view}`}>
      <div className="empty-illustration" aria-hidden="true">
        <svg viewBox="0 0 240 160">
          <rect
            x="35"
            y="32"
            width="170"
            height="100"
            rx="14"
            fill="var(--card)"
            stroke="var(--border)"
          />
          <path
            d="M57 112h126M57 90h66M57 67h86"
            stroke="var(--tint)"
            strokeWidth="8"
            strokeLinecap="round"
          />
          <circle cx="176" cy="53" r="30" fill="var(--tint)" />
          <path
            d="m164 53 9 9 16-19"
            stroke="var(--brand)"
            strokeWidth="4"
            fill="none"
            strokeLinecap="round"
          />
          <path
            d="M73 132v12m94-12v12"
            stroke="var(--border)"
            strokeWidth="5"
          />
        </svg>
      </div>
      <span className="eyebrow">A clean start</span>
      <h2>Your {app.entity}s belong here.</h2>
      <p>
        {app.description}{" "}
        {app.services.length
          ? "Add your first record, or choose connected accounts for a Matrix-assisted import."
          : "Add your first entry and make this workspace your own."}
      </p>
      <button className="primary" onClick={onAdd}>
        Add {app.entity}
      </button>
      <small>
        Nothing is prefilled. Every number will come from your records.
      </small>
    </div>
  );
}

/**
 * The bulk drafts review list: one row per recipient with its status, a
 * checkbox, and an inline editor the owner opens to change subject or body.
 */
import { useState } from "react";
import { Badge, Checkbox, TextField } from "../../../../_shared/office-ui";
import type { BulkDrafts } from "../../agent/bulk";
import type { BulkRow, BulkRowStatus } from "../../agent/bulk-state";

const STATUS: Record<BulkRowStatus, { label: string; tone: "neutral" | "accent" | "success" | "warning" | "danger" }> = {
  queued: { label: "Waiting", tone: "neutral" },
  generating: { label: "Writing", tone: "accent" },
  ready: { label: "Ready", tone: "accent" },
  failed: { label: "Failed", tone: "danger" },
  creating: { label: "Saving", tone: "accent" },
  created: { label: "Draft saved", tone: "success" },
  create_failed: { label: "Not saved", tone: "danger" },
  sending: { label: "Sending", tone: "accent" },
  sent: { label: "Sent", tone: "success" },
  send_failed: { label: "Not sent", tone: "danger" },
};

const EDITABLE = new Set<BulkRowStatus>(["ready", "created", "create_failed", "send_failed"]);

function RowItem({ row, bulk, busy }: { row: BulkRow; bulk: BulkDrafts; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const status = STATUS[row.status];
  const editable = EDITABLE.has(row.status) && !busy;
  const label = row.to ?? "No address";
  return (
    <li className="mail-bulk__row" data-status={row.status}>
      <div className="mail-bulk__row-head">
        <Checkbox
          label={`Row ${row.index + 1}: ${label}`}
          checked={row.selected}
          disabled={!editable}
          onChange={(checked) => bulk.setSelected(row.index, checked)}
        />
        <Badge tone={status.tone}>{status.label}</Badge>
        {row.subject && <span className="mail-bulk__subject">{row.subject}</span>}
        <span className="mail-bulk__row-actions">
          {editable && (
            <button type="button" className="oui-button oui-button--ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              {open ? "Close" : "Open"}
            </button>
          )}
          {row.status === "failed" && row.to && !busy && (
            <button type="button" className="oui-button oui-button--ghost" onClick={() => void bulk.retry(row.index)}>Retry</button>
          )}
        </span>
      </div>
      {row.error && <p className="mail-bulk__error">{row.error}</p>}
      {open && editable && (
        <div className="mail-bulk__editor">
          <TextField label="Subject" value={row.subject} maxLength={255} onChange={(subject) => bulk.edit(row.index, { subject })} />
          <TextField label="Message" multiline rows={8} value={row.body} maxLength={20000} onChange={(body) => bulk.edit(row.index, { body })} />
        </div>
      )}
    </li>
  );
}

export function BulkRowList({ rows, bulk, busy }: { rows: readonly BulkRow[]; bulk: BulkDrafts; busy: boolean }) {
  return (
    <ul className="mail-bulk__rows" aria-label="Drafts">
      {rows.map((row) => (
        <RowItem key={row.index} row={row} bulk={bulk} busy={busy} />
      ))}
    </ul>
  );
}

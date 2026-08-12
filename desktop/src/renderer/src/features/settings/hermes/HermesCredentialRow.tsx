import type { HermesEnvironmentEntry } from "@matrix-os/contracts";
import { Check, KeyRound, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "../../../design/primitives";

interface HermesCredentialRowProps {
  credentialKey: string;
  entry: HermesEnvironmentEntry;
  busy: boolean;
  onSave: (key: string, value: string) => Promise<boolean>;
  onRemove: (key: string) => Promise<boolean>;
}

export function HermesCredentialRow({ credentialKey, entry, busy, onSave, onRemove }: HermesCredentialRowProps) {
  const [value, setValue] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const managed = entry.channel_managed;

  return (
    <article className="rounded-lg border p-4" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <KeyRound size={14} style={{ color: "var(--accent)" }} />
            <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>{credentialKey}</span>
            {entry.is_set ? (
              <span className="flex items-center gap-1 text-xs" style={{ color: "var(--success)" }}>
                <Check size={12} />Configured
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-xs" style={{ color: "var(--text-secondary)" }}>
            {entry.provider_label || entry.description}
            {entry.is_set && entry.redacted_value ? ` · ${entry.redacted_value}` : ""}
          </p>
        </div>
        {entry.is_set && !managed ? (
          confirmRemove ? (
            <div className="flex gap-1">
              <Button variant="ghost" disabled={busy} onClick={() => setConfirmRemove(false)}>Cancel</Button>
              <Button
                variant="danger"
                aria-label={`Confirm remove ${credentialKey}`}
                disabled={busy}
                onClick={() => void onRemove(credentialKey).then((removed) => { if (removed) setConfirmRemove(false); })}
              >
                Remove
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              aria-label={`Remove ${credentialKey}`}
              disabled={busy}
              onClick={() => setConfirmRemove(true)}
            >
              <Trash2 size={13} />Remove
            </Button>
          )
        ) : null}
      </div>
      {managed ? (
        <p className="mt-3 text-xs" style={{ color: "var(--text-tertiary)" }}>Managed by a connected channel.</p>
      ) : (
        <div className="mt-3 flex items-end gap-2">
          <label className="min-w-0 flex-1 text-xs" style={{ color: "var(--text-secondary)" }}>
            {entry.is_set ? "Replace value" : "New value"}
            <input
              aria-label={`${credentialKey} value`}
              type={entry.is_password ? "password" : "text"}
              autoComplete="off"
              className="mt-1 h-9 w-full rounded-md border bg-transparent px-2.5 text-sm outline-none"
              style={{ borderColor: "var(--border-default)", color: "var(--text-primary)" }}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
          <Button
            variant="primary"
            aria-label={`Save ${credentialKey}`}
            disabled={busy || value.length === 0}
            onClick={() => void onSave(credentialKey, value).then((saved) => { if (saved) setValue(""); })}
          >
            Save
          </Button>
        </div>
      )}
    </article>
  );
}

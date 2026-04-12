"use client";

import { useState } from "react";

export interface GroupAcl {
  read_pl: number;
  write_pl: number;
  install_pl: number;
  policy: "open" | "moderated" | "owner_only";
}

interface AppAclPanelProps {
  acl: GroupAcl;
  groupSlug: string;
  appSlug: string;
  myPowerLevel: number;
  onSaved?: (acl: GroupAcl) => void;
}

const PL_PRESETS = [0, 50, 100] as const;

export function AppAclPanel({ acl: initialAcl, groupSlug, appSlug, myPowerLevel, onSaved }: AppAclPanelProps) {
  // committed tracks the last successfully saved (or initial) ACL for rollback
  const [committed, setCommitted] = useState<GroupAcl>(initialAcl);
  const [current, setCurrent] = useState<GroupAcl>(initialAcl);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const disabled = myPowerLevel < current.install_pl;

  async function handleSave() {
    const snapshot = committed;
    setSaving(true);
    setError(null);

    try {
      const res = await fetch(`/api/groups/${groupSlug}/apps/${appSlug}/acl`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(current),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        setCurrent(snapshot);
        const body = await res.json().catch(() => ({})) as { error?: string };
        setError(body.error ?? `Save failed (${res.status})`);
        return;
      }

      setCommitted(current);
      onSaved?.(current);
    } catch {
      setCurrent(snapshot);
      setError("Failed to save — network error");
    } finally {
      setSaving(false);
    }
  }

  function update<K extends keyof GroupAcl>(key: K, value: GroupAcl[K]) {
    setCurrent((prev) => ({ ...prev, [key]: value }));
  }

  const fields = (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <label className="w-24 text-sm text-muted-foreground" htmlFor="acl-read-pl">
          Read PL
        </label>
        <select
          id="acl-read-pl"
          aria-label="Read power level"
          disabled={disabled}
          value={current.read_pl}
          onChange={(e) => update("read_pl", Number(e.target.value))}
          className="flex-1 rounded border border-input bg-background px-2 py-1 text-sm disabled:opacity-50"
        >
          {PL_PRESETS.map((pl) => (
            <option key={pl} value={pl}>{pl}</option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-3">
        <label className="w-24 text-sm text-muted-foreground" htmlFor="acl-write-pl">
          Write PL
        </label>
        <select
          id="acl-write-pl"
          aria-label="Write power level"
          disabled={disabled}
          value={current.write_pl}
          onChange={(e) => update("write_pl", Number(e.target.value))}
          className="flex-1 rounded border border-input bg-background px-2 py-1 text-sm disabled:opacity-50"
        >
          {PL_PRESETS.map((pl) => (
            <option key={pl} value={pl}>{pl}</option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-3">
        <label className="w-24 text-sm text-muted-foreground" htmlFor="acl-install-pl">
          Install PL
        </label>
        <select
          id="acl-install-pl"
          aria-label="Install power level"
          disabled={disabled}
          value={current.install_pl}
          onChange={(e) => update("install_pl", Number(e.target.value))}
          className="flex-1 rounded border border-input bg-background px-2 py-1 text-sm disabled:opacity-50"
        >
          {PL_PRESETS.map((pl) => (
            <option key={pl} value={pl}>{pl}</option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-3">
        <label className="w-24 text-sm text-muted-foreground" htmlFor="acl-policy">
          Policy
        </label>
        <select
          id="acl-policy"
          aria-label="Policy"
          disabled={disabled}
          value={current.policy}
          onChange={(e) => update("policy", e.target.value as GroupAcl["policy"])}
          className="flex-1 rounded border border-input bg-background px-2 py-1 text-sm disabled:opacity-50"
        >
          <option value="open">open</option>
          <option value="moderated">moderated</option>
          <option value="owner_only">owner_only</option>
        </select>
      </div>
    </div>
  );

  const saveButton = (
    <button
      type="button"
      disabled={disabled || saving}
      onClick={handleSave}
      className="mt-4 rounded bg-primary px-4 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
    >
      {saving ? "Saving..." : "Save"}
    </button>
  );

  return (
    <div className="rounded-lg border border-border p-4">
      <h3 className="mb-3 text-sm font-semibold">App Permissions</h3>

      {fields}

      {error && (
        <p className="mt-2 text-xs text-destructive">{error}</p>
      )}

      {disabled ? (
        <span
          className="inline-block"
          title={`Insufficient permissions — install_pl ${current.install_pl} required`}
        >
          {saveButton}
        </span>
      ) : saveButton}
    </div>
  );
}

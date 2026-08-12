import { Check, X } from "lucide-react";
import { IconButton } from "../../design/primitives";

export function InlineNameEditor({
  kind,
  value,
  error,
  onChange,
  onSubmit,
  onCancel,
  mode = "create",
  originalName,
  disabled = false,
}: {
  kind: "file" | "directory";
  value: string;
  error?: string | null;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  mode?: "create" | "rename";
  originalName?: string;
  disabled?: boolean;
}) {
  const noun = kind === "directory" ? "folder" : "file";
  const rename = mode === "rename";
  return (
    <div className="rounded-md px-2 py-1.5" style={{ background: "var(--bg-selected)" }}>
      <div className="flex items-center gap-1.5">
        <input
          autoFocus
          disabled={disabled}
          aria-label={rename ? `Rename ${originalName ?? noun}` : `New ${noun} name`}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onSubmit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              onCancel();
            }
          }}
          className="min-w-0 flex-1 rounded border px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-[var(--accent)]"
          style={{ background: "var(--bg-surface)", borderColor: "var(--border-default)", color: "var(--text-primary)" }}
        />
        <IconButton label={rename ? "Save rename" : `Create ${noun}`} disabled={disabled} onClick={onSubmit}><Check size={13} /></IconButton>
        <IconButton label={rename ? "Cancel rename" : `Cancel new ${noun}`} disabled={disabled} onClick={onCancel}><X size={13} /></IconButton>
      </div>
      {error ? <p role="alert" className="mt-1 text-xs" style={{ color: "var(--danger)" }}>{error}</p> : null}
    </div>
  );
}

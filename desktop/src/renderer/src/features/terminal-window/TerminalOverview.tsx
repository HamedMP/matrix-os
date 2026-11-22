// The Terminal window's overview (spec 2706): every terminal of the active
// space (or all of them) as a card with its icon, name, status, where it runs,
// how long since it changed and a live preview of its screen. A click opens
// it; the pencil renames it in place. Opened from the tab bar or Cmd+Shift+O.
import { useState, type FormEvent } from "react";
import { LoaderCircle, Pencil, SquareTerminal } from "lucide-react";
import { terminalSinceLabel, type TerminalSidebarRow } from "@matrix-os/ui/terminal-status-sidebar";

const secondaryText = { color: "var(--text-secondary, var(--color-muted-foreground))" };
const STATUS_LABEL: Record<string, string> = { working: "Working", blocked: "Needs you", error: "Error", done: "Done", idle: "Idle" };
const STATUS_COLOR: Record<string, string> = { working: "#d97706", blocked: "#d97706", error: "#dc2626", done: "#10b981" };

function StatusPill({ row }: { row: TerminalSidebarRow }) {
  const status = row.status === "done" && row.seen ? "idle" : row.status ?? "idle";
  return (
    <span className="flex shrink-0 items-center gap-1 text-[11px]" style={{ color: STATUS_COLOR[status] ?? secondaryText.color }}>
      {status === "working" ? <LoaderCircle size={11} aria-hidden="true" className="animate-spin" /> : <span aria-hidden="true" className="size-1.5 rounded-full" style={{ background: "currentColor" }} />}
      {STATUS_LABEL[status]}
    </span>
  );
}

function CardName({ row, onRename }: { row: TerminalSidebarRow; onRename(name: string): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null) {
    return (
      <span className="flex min-w-0 flex-1 items-center gap-1">
        <span className="min-w-0 truncate text-[13px] font-medium">{row.space ? <><span className="font-semibold">{row.space}</span><span style={secondaryText}> · {row.name}</span></> : row.name}</span>
        <button type="button" aria-label={`Rename ${row.name}`} title="Rename"
          onClick={(event) => { event.stopPropagation(); setDraft(row.name); }}
          className="flex size-5 shrink-0 items-center justify-center rounded opacity-0 outline-none hover:bg-black/10 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-current group-hover:opacity-100"
          style={secondaryText}>
          <Pencil size={11} aria-hidden="true" />
        </button>
      </span>
    );
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const name = draft.trim();
    if (name && name !== row.name) onRename(name.slice(0, 64));
    setDraft(null);
  };
  return (
    <form className="min-w-0 flex-1" onSubmit={submit} onClick={(event) => event.stopPropagation()}>
      {/* react-doctor-disable-next-line react-doctor/no-autofocus -- the person just chose Rename */}
      <input aria-label="Terminal name" value={draft} maxLength={64} autoFocus onChange={(event) => setDraft(event.target.value)}
        onBlur={() => setDraft(null)} onKeyDown={(event) => { if (event.key === "Escape") setDraft(null); }}
        className="w-full rounded border bg-transparent px-1.5 py-0.5 text-[13px] outline-none" style={{ borderColor: "var(--border-default)" }} />
    </form>
  );
}

export function TerminalOverview({ rows, previews, selectedKey, now, spaceLabel, onOpen, onRename }: {
  rows: readonly TerminalSidebarRow[];
  previews: Readonly<Record<string, string[]>>;
  selectedKey: string | null;
  now: number;
  /** The active space's name, or null for All. */
  spaceLabel: string | null;
  onOpen(key: string): void;
  onRename(key: string, name: string): void;
}) {
  return (
    <main aria-label="Overview" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-4" style={{ background: "var(--bg-app, var(--bg-sunken))" }}>
      <h1 className="pb-3 text-[13px] font-semibold">
        {spaceLabel ? `${spaceLabel}: ` : "All terminals: "}<span className="font-normal" style={secondaryText}>{rows.length}</span>
      </h1>
      {rows.length === 0 ? (
        <p className="text-[13px]" style={secondaryText}>No terminals here yet. Start one with Cmd+T.</p>
      ) : (
        <ul aria-label="Terminals overview" className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
          {rows.map((row) => {
            const since = terminalSinceLabel(row.statusAt, now);
            const lines = previews[row.key];
            return (
              <li key={row.key}>
                {/* The whole card opens the terminal; its rename control stops the click. */}
                <div role="button" tabIndex={0} aria-label={`Open ${row.name}`} aria-current={row.key === selectedKey ? "true" : undefined}
                  onClick={() => onOpen(row.key)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(row.key); } }}
                  className="group flex h-44 cursor-pointer flex-col gap-1.5 rounded-lg border p-2.5 text-left outline-none hover:border-[var(--border-default)] focus-visible:ring-2 focus-visible:ring-current"
                  style={{ borderColor: row.key === selectedKey ? "#3b82f6" : "var(--border-subtle)", background: "var(--bg-surface)" }}>
                  <span className="flex items-center gap-2">
                    <SquareTerminal size={13} aria-hidden="true" className="shrink-0" style={secondaryText} />
                    <CardName row={row} onRename={(name) => onRename(row.key, name)} />
                    <StatusPill row={row} />
                  </span>
                  <span className="flex min-w-0 items-center gap-2 text-[11px]" style={secondaryText}>
                    <span className="min-w-0 flex-1 truncate">{[row.machine.name, row.detail].filter(Boolean).join(" · ")}</span>
                    {since ? <span className="shrink-0 tabular-nums">{since}</span> : null}
                  </span>
                  <pre aria-label={`${row.name} preview`} className="min-h-0 flex-1 overflow-hidden rounded-md px-2 py-1.5 font-mono text-[10.5px] leading-[1.35]"
                    style={{ background: "#0b0b0b", color: "#d4d4d4" }}>
                    {lines && lines.length > 0 ? lines.join("\n") : ""}
                  </pre>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}

// The Terminal window's small dialogs (spec 2706): the Cmd+P picker, F2
// rename, and the confirmation before Cmd+W ends a running program.
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button, DestructiveConfirmDialog, Dialog, Input } from "@matrix-os/ui";
import type { TerminalSidebarEntry } from "@matrix-os/ui/terminal-status-sidebar";

const secondaryText = { color: "var(--text-secondary, var(--color-muted-foreground))" };
const MAX_PICKER_ROWS = 50;

/** Jump to any terminal by name, in sidebar order. */
export function TerminalPicker({ open, entries, onPick, onClose }: {
  open: boolean;
  entries: readonly TerminalSidebarEntry[];
  onPick(key: string): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries.filter((entry) => !needle || entry.name.toLowerCase().includes(needle)
      || entry.machine.name.toLowerCase().includes(needle)).slice(0, MAX_PICKER_ROWS);
  }, [entries, query]);
  // The highlighted match, kept within the list when live updates shrink it.
  const current = Math.min(active, Math.max(0, matches.length - 1));
  // The highlighted match stays in view as the arrow keys move it.
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>("[aria-current=true]")?.scrollIntoView?.({ block: "nearest" });
  }, [current, matches]);
  const close = () => { setQuery(""); setActive(0); onClose(); };
  const pick = (key: string) => { setQuery(""); setActive(0); onPick(key); };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setActive(Math.min(current + 1, matches.length - 1)); }
    if (event.key === "ArrowUp") { event.preventDefault(); setActive(Math.max(current - 1, 0)); }
    if (event.key === "Enter" && matches[current]) { event.preventDefault(); pick(matches[current]!.key); }
  };
  return (
    <Dialog open={open} onClose={close} aria-label="Go to terminal" style={{ padding: 12, maxWidth: 520 }}>
      <Input aria-label="Terminal name" placeholder="Go to terminal…" value={query} autoFocus
        onChange={(event) => { setQuery(event.target.value); setActive(0); }} onKeyDown={onKeyDown} />
      <ul ref={list} aria-label="Terminals" className="mt-2 flex max-h-80 flex-col gap-0.5 overflow-y-auto">
        {matches.length === 0 ? <li className="px-2 py-1.5 text-[13px]" style={secondaryText}>No terminal matches.</li> : null}
        {matches.map((entry, index) => (
          <li key={entry.key}>
            <button type="button" aria-current={index === current ? "true" : undefined} onClick={() => pick(entry.key)}
              onMouseEnter={() => setActive(index)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] outline-none"
              style={index === current ? { background: "var(--bg-hover, rgba(127,127,127,0.18))" } : undefined}>
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              <span className="shrink-0 text-[11px]" style={secondaryText}>{entry.machine.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

/** F2: a new name for the selected terminal. */
export function RenameTerminalDialog({ target, onRename, onClose }: {
  target: { key: string; name: string } | null;
  onRename(key: string, name: string): void;
  onClose(): void;
}) {
  return (
    <Dialog open={target !== null} onClose={onClose} aria-label="Rename terminal" style={{ maxWidth: 400 }}>
      {target ? <RenameForm key={target.key} target={target} onRename={onRename} onClose={onClose} /> : null}
    </Dialog>
  );
}

function RenameForm({ target, onRename, onClose }: {
  target: { key: string; name: string }; onRename(key: string, name: string): void; onClose(): void;
}) {
  // react-doctor-disable-next-line react-doctor/no-derived-useState -- the form mounts fresh for each rename; the name only seeds the draft
  const [draft, setDraft] = useState(target.name);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const name = draft.trim().slice(0, 64);
    if (name && name !== target.name) onRename(target.key, name);
    onClose();
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <h2 className="text-[15px] font-semibold">Rename terminal</h2>
      <Input aria-label="Terminal name" value={draft} maxLength={64} autoFocus onChange={(event) => setDraft(event.target.value)} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
        <Button type="submit" size="sm">Rename</Button>
      </div>
    </form>
  );
}

/** Cmd+W on a terminal whose program still runs: ending it stops that program. */
export function CloseTerminalDialog({ target, onConfirm, onClose }: {
  target: { key: string; name: string; pane: boolean } | null;
  onConfirm(key: string): void;
  onClose(): void;
}) {
  // "End pane" while it is one pane of a split; "End terminal" for the last pane or a tab.
  const action = target?.pane ? "End pane" : "End terminal";
  return (
    <DestructiveConfirmDialog open={target !== null} title={target ? `End “${target.name}”?` : action}
      body="Its program is still running and will stop." confirmLabel={action} confirmVerb="End"
      onCancel={onClose} onConfirm={() => { if (target) onConfirm(target.key); onClose(); }} />
  );
}

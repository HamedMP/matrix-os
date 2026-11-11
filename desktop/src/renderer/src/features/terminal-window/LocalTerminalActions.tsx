// The "+" choices and inline rename for This Computer terminals, as in Herdr's
// tab bar: a plain shell or one of the known coding agents.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Plus } from "lucide-react";
import type { LocalTerminalAgent } from "../../../../shared/local-terminals";

const AGENTS: Array<{ id: LocalTerminalAgent; label: string }> = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "opencode", label: "OpenCode" },
  { id: "pi", label: "Pi" },
];

const secondaryText = { color: "var(--text-secondary, var(--color-muted-foreground))" };
const itemClass = "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-current disabled:opacity-50";

export function NewLocalTerminalMenu({ creating, onCreate }: {
  creating: boolean;
  onCreate(launch: { agent?: LocalTerminalAgent }): void;
}) {
  const [open, setOpen] = useState(false);
  const choose = (launch: { agent?: LocalTerminalAgent }) => {
    setOpen(false);
    onCreate(launch);
  };
  return (
    <div onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}>
      <button type="button" disabled={creating} aria-expanded={open} aria-haspopup="true"
        onClick={() => setOpen((shown) => !shown)} className={itemClass} style={secondaryText}>
        <Plus size={12} aria-hidden="true" className="shrink-0" />
        {creating ? "Starting…" : "New terminal"}
      </button>
      {open ? (
        <ul aria-label="Start" className="ml-4 flex flex-col gap-0.5">
          <li><button type="button" className={itemClass} onClick={() => choose({})}>Shell</button></li>
          {AGENTS.map((agent) => (
            <li key={agent.id}>
              <button type="button" className={itemClass} onClick={() => choose({ agent: agent.id })}>{agent.label}</button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Inline rename for one terminal; the name shows on every client of this core. */
export function LocalTerminalRenameInput({ title, onDone }: { title: string; onDone(name: string | null): void }) {
  // react-doctor-disable-next-line react-doctor/no-derived-useState -- the input mounts fresh for each rename; the title only seeds the draft
  const [draft, setDraft] = useState(title);
  const input = useRef<HTMLInputElement>(null);
  // The person just pressed Rename: move focus into the field they asked for.
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  // Enter or Escape ends the edit, and the blur that follows must not end it again.
  const finished = useRef(false);
  const finish = (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const name = draft.trim().slice(0, 64);
    onDone(save && name && name !== title ? name : null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") finish(true);
    if (event.key === "Escape") finish(false);
  };
  return (
    <input ref={input} aria-label="Terminal name" value={draft} maxLength={64}
      onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} onBlur={() => finish(true)}
      className="mx-2 my-0.5 min-w-0 flex-1 rounded border bg-transparent px-1 py-0.5 text-[12px] outline-none" />
  );
}

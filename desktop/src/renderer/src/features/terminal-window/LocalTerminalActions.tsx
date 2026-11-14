// The "+" choices and inline rename for This Computer terminals, as in Herdr's
// tab bar: a plain shell or one of the known coding agents.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Plus } from "lucide-react";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import type { LocalTerminalAgent } from "../../../../shared/local-terminals";

const AGENTS: Array<{ id: LocalTerminalAgent; label: string }> = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "opencode", label: "OpenCode" },
  { id: "pi", label: "Pi" },
];

const secondaryText = { color: "var(--text-secondary, var(--color-muted-foreground))" };
const itemClass = "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-current disabled:opacity-50";

/** The "+" menu, as the app's other menus: it overlays the list and closes on any outside click or Escape. */
export function NewLocalTerminalMenu({ creating, onCreate }: {
  creating: boolean;
  onCreate(launch: { agent?: LocalTerminalAgent }): void;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" disabled={creating} className={itemClass} style={secondaryText}>
          <Plus size={12} aria-hidden="true" className="shrink-0" />
          {creating ? "Starting…" : "New terminal"}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          aria-label="Start"
          align="start"
          sideOffset={4}
          className="fade-in min-w-[180px] rounded-lg border p-1"
          style={{ zIndex: DESKTOP_Z_INDEX.popover, background: "var(--bg-overlay)", borderColor: "var(--border-default)", boxShadow: "var(--shadow-2)" }}
        >
          <MenuChoice label="Shell" onSelect={() => onCreate({})} />
          <DropdownMenu.Separator className="my-1 h-px" style={{ background: "var(--border-subtle)" }} />
          {AGENTS.map((agent) => (
            <MenuChoice key={agent.id} label={agent.label} onSelect={() => onCreate({ agent: agent.id })} />
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function MenuChoice({ label, onSelect }: { label: string; onSelect(): void }) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className="flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] outline-none data-[highlighted]:bg-[var(--bg-hover)]"
      style={{ color: "var(--text-primary)" }}
    >
      {label}
    </DropdownMenu.Item>
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

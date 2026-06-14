import { Command } from "cmdk";
import { Kanban, MessageSquarePlus, Plus, Settings, SquareTerminal } from "lucide-react";
import { useBoard } from "../../stores/board";
import { useSessions } from "../../stores/sessions";
import { useUi } from "../../stores/ui";

export default function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPaletteOpen);
  const navigate = useUi((s) => s.navigate);
  const setCreateTaskOpen = useUi((s) => s.setCreateTaskOpen);
  const setComposerOpen = useUi((s) => s.setComposerOpen);
  const activeSlug = useBoard((s) => s.activeProjectSlug);
  const cardsByProject = useBoard((s) => s.cardsByProject);
  const sessions = useSessions((s) => s.sessions);

  if (!open) return null;

  const cards = activeSlug ? (cardsByProject[activeSlug] ?? []) : [];

  const run = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[16vh]"
      style={{ background: "rgba(0,0,0,0.45)" }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <Command
        label="Command palette"
        className="fade-in w-[560px] overflow-hidden rounded-xl border"
        style={{
          background: "var(--bg-overlay)",
          borderColor: "var(--border-default)",
          boxShadow: "var(--shadow-3)",
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
      >
        <Command.Input
          autoFocus
          placeholder="Search tasks, sessions, actions…"
          className="w-full border-b bg-transparent px-4 py-3 text-md outline-none"
          style={{ borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}
        />
        <Command.List className="max-h-[320px] overflow-y-auto p-1.5">
          <Command.Empty
            className="px-3 py-6 text-center text-sm"
            style={{ color: "var(--text-tertiary)" }}
          >
            No results.
          </Command.Empty>

          <Command.Group
            heading="Actions"
            className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide"
            style={{ color: "var(--text-tertiary)" }}
          >
            <PaletteItem icon={<Plus size={14} />} label="New task" shortcut="C" onSelect={() => run(() => setCreateTaskOpen(true))} />
            <PaletteItem icon={<MessageSquarePlus size={14} />} label="New agent thread" shortcut="⌘J" onSelect={() => run(() => setComposerOpen(true))} />
            <PaletteItem icon={<Kanban size={14} />} label="Go to board" onSelect={() => run(() => navigate({ kind: "board" }))} />
            <PaletteItem icon={<SquareTerminal size={14} />} label="Go to sessions" onSelect={() => run(() => navigate({ kind: "sessions" }))} />
            <PaletteItem icon={<Settings size={14} />} label="Open settings" onSelect={() => run(() => navigate({ kind: "settings" }))} />
          </Command.Group>

          {cards.length > 0 ? (
            <Command.Group heading="Tasks" style={{ color: "var(--text-tertiary)" }}>
              {cards.slice(0, 30).map((card) => (
                <PaletteItem
                  key={card.id}
                  icon={<Kanban size={14} />}
                  label={card.title}
                  onSelect={() => run(() => navigate({ kind: "task", taskId: card.id }))}
                />
              ))}
            </Command.Group>
          ) : null}

          {sessions.length > 0 ? (
            <Command.Group heading="Sessions" style={{ color: "var(--text-tertiary)" }}>
              {sessions.slice(0, 20).map((session) => (
                <PaletteItem
                  key={session.attachName}
                  icon={<SquareTerminal size={14} />}
                  label={session.name}
                  onSelect={() =>
                    run(() => navigate({ kind: "session", sessionName: session.attachName }))
                  }
                />
              ))}
            </Command.Group>
          ) : null}
        </Command.List>
      </Command>
    </div>
  );
}

function PaletteItem({
  icon,
  label,
  shortcut,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  onSelect: () => void;
}) {
  return (
    <Command.Item
      onSelect={onSelect}
      className="flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-2 text-sm data-[selected=true]:bg-[var(--bg-selected)]"
      style={{ color: "var(--text-primary)" }}
    >
      <span style={{ color: "var(--text-tertiary)" }}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {shortcut ? (
        <kbd className="text-xs" style={{ color: "var(--text-tertiary)" }}>
          {shortcut}
        </kbd>
      ) : null}
    </Command.Item>
  );
}

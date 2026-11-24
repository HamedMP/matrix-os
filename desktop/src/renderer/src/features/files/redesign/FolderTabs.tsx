import { Folder, Plus, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Icon, IconButton, pillTabClass, rovingIndex } from "../../../design/ds";
import { cn } from "../../../lib/cn";

export interface FolderTabModel {
  id: string;
  title: string;
}

/**
 * Folder tabs as design-library pill triggers. Each tab is closable while more
 * than one is open; arrows move between tabs and Delete closes the focused one.
 */
export function FolderTabs({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNewTab,
}: {
  tabs: FolderTabModel[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewTab: () => void;
}) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  // Closing the focused tab removes its button; focus moves to the neighbour once it renders.
  const pendingFocus = useRef<string | null>(null);
  const closable = tabs.length > 1;

  useEffect(() => {
    const id = pendingFocus.current;
    if (id === null) return;
    pendingFocus.current = null;
    refs.current.get(id)?.focus();
  }, [tabs]);
  return (
    <div className="flex min-w-0 items-center gap-1">
      <div role="tablist" aria-label="Open folders" className="flex min-w-0 items-center gap-1 overflow-x-auto">
        {tabs.map((tab, index) => {
          const active = tab.id === activeId;
          return (
            <div key={tab.id} className={cn(pillTabClass(active), "max-w-48 shrink-0 pr-1 pl-2.5")}>
              <button
                ref={(el) => {
                  if (el) refs.current.set(tab.id, el);
                  else refs.current.delete(tab.id);
                }}
                type="button"
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                onClick={() => onSelect(tab.id)}
                onKeyDown={(event) => {
                  if ((event.key === "Delete" || event.key === "Backspace") && closable) {
                    event.preventDefault();
                    pendingFocus.current = (tabs[index - 1] ?? tabs[index + 1])?.id ?? null;
                    onClose(tab.id);
                    return;
                  }
                  const next = rovingIndex(event.key, index, tabs.length);
                  if (next === null) return;
                  event.preventDefault();
                  onSelect(tabs[next]!.id);
                  refs.current.get(tabs[next]!.id)?.focus();
                }}
                className="ds-focus flex min-w-0 items-center gap-1.5 rounded-sm outline-none"
              >
                <Icon icon={Folder} size="xs" className="shrink-0 text-ds-muted-foreground" />
                <span className="truncate" title={tab.title}>{tab.title}</span>
              </button>
              {closable ? (
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={`Close ${tab.title}`}
                  onClick={() => onClose(tab.id)}
                  className="ds-focus ml-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm text-ds-muted-foreground hover:bg-ds-accent-strong hover:text-ds-foreground"
                >
                  <Icon icon={X} size="xxs" />
                </button>
              ) : <span className="w-1" />}
            </div>
          );
        })}
      </div>
      <IconButton label="New tab" size="xs" onClick={onNewTab}>
        <Icon icon={Plus} size="xs" />
      </IconButton>
    </div>
  );
}

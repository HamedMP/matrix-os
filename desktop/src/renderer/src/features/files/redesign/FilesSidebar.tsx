import { Lock } from "lucide-react";
import type { ReactNode } from "react";
import { dsCn as cn } from "../../../design/ds";

export interface NavItemModel {
  id: string;
  label: string;
  icon: ReactNode;
  /** Trailing count (Trash). */
  count?: number;
  /** Managed locations show a lock and are read-only. */
  locked?: boolean;
  /** Blue dot for drives that changed since they were last opened. */
  changed?: boolean;
}

export interface NavSectionModel {
  id: string;
  /** Uppercase group label; omitted for the top group. */
  label?: string;
  items: NavItemModel[];
}

/** One 32px sidebar row; the active row uses the bordered style and aria-current. */
export function NavItem({ item, active, onSelect }: { item: NavItemModel; active: boolean; onSelect: (id: string) => void }) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={() => onSelect(item.id)}
      className={cn(
        "ds-focus no-drag flex h-8 w-full min-w-0 items-center gap-2 rounded-md border px-2 text-left font-ds-sans text-ds-ui transition-colors duration-[120ms]",
        "[&_svg]:size-3.5 [&_svg]:shrink-0",
        active
          ? "border-ds-border bg-ds-background font-medium text-ds-foreground shadow-ds-xs [&_svg]:text-ds-foreground"
          : "border-transparent text-ds-foreground hover:bg-ds-accent [&_svg]:text-ds-muted-foreground",
      )}
    >
      {item.icon}
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.changed ? <span className="size-1.5 shrink-0 rounded-full bg-ds-info" aria-label="Changed since you last opened it" role="img" /> : null}
      {item.locked ? <Lock aria-label="Managed, read-only" role="img" className="size-3! text-ds-muted-foreground!" /> : null}
      {typeof item.count === "number" && item.count > 0 ? <span className="text-ds-ui-xs text-ds-muted-foreground tabular-nums">{item.count}</span> : null}
    </button>
  );
}

/**
 * Files sidebar: an optional header slot (New, Search), labelled groups of
 * rows separated by thin dividers, and a footer pinned to the bottom (Trash).
 * Window controls are drawn by OSWindow, not here.
 */
export function FilesSidebar({
  header,
  sections,
  footer,
  activeId,
  onSelect,
}: {
  header?: ReactNode;
  sections: NavSectionModel[];
  footer?: NavSectionModel;
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <nav aria-label="Files locations" className="flex h-full min-h-0 flex-col font-ds-sans">
      {header ? <div className="flex flex-col gap-0.5 px-3 pb-2">{header}</div> : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-3">
        {sections.map((section, index) => (
          <div key={section.id} className={cn(index > 0 && "mt-2 border-t border-ds-tint-neutral-border pt-2")}>
            {section.label ? <h2 className="px-2 pt-1 pb-1 text-ds-cap font-medium tracking-[0.06em] text-ds-muted-foreground uppercase">{section.label}</h2> : null}
            <ul className="flex flex-col gap-0.5">
              {section.items.map((item) => (
                <li key={item.id}><NavItem item={item} active={item.id === activeId} onSelect={onSelect} /></li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {footer ? (
        <div className="border-t border-ds-tint-neutral-border px-3 py-2">
          <ul className="flex flex-col gap-0.5">
            {footer.items.map((item) => (
              <li key={item.id}><NavItem item={item} active={item.id === activeId} onSelect={onSelect} /></li>
            ))}
          </ul>
        </div>
      ) : null}
    </nav>
  );
}

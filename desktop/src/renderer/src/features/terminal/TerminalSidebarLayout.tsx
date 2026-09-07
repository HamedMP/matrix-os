import { PanelLeftOpenIcon } from "@renderer/lib/hugeicons";
import { type ReactNode, type Ref, useId, useLayoutEffect, useRef, useState } from "react";
import { OSWindowSafeView } from "../desktop-shell/OSWindow";

interface SidebarControls {
  sidebarId: string;
  collapseButtonRef: Ref<HTMLButtonElement>;
  onCollapse: () => void;
}

/** Retain the session list and terminal buffers while toggling their layout. */
export function TerminalSidebarLayout({
  sidebar,
  children,
}: {
  sidebar: (controls: SidebarControls) => ReactNode;
  children: ReactNode;
}) {
  const sidebarId = useId();
  const [shown, setShown] = useState(true);
  const collapseButtonRef = useRef<HTMLButtonElement>(null);
  const expandButtonRef = useRef<HTMLButtonElement>(null);
  const focusAfterToggle = useRef(false);

  const toggle = (next: boolean) => {
    focusAfterToggle.current = true;
    setShown(next);
  };

  useLayoutEffect(() => {
    if (!focusAfterToggle.current) return;
    focusAfterToggle.current = false;
    (shown ? collapseButtonRef : expandButtonRef).current?.focus();
  }, [shown]);

  return (
    <OSWindowSafeView
      // Floating Terminal windows put their chrome over the expanded sidebar.
      // Once it collapses, reserve that space across the rail and session pane.
      area={shown ? "pane" : "sidebar"}
      data-testid="desktop-terminal-app"
      className="relative flex min-h-0 flex-1 overflow-hidden"
      style={{ background: "var(--bg-app)", color: "var(--text-primary)" }}
    >
      <div
        id={sidebarId}
        data-terminal-tabs-sidebar
        hidden={!shown}
        className={shown ? "w-[280px] min-w-[200px] max-w-[280px] shrink-0 border-r" : "hidden"}
        style={{ borderColor: "var(--border-subtle)" }}
      >
        {sidebar({ sidebarId, collapseButtonRef, onCollapse: () => toggle(false) })}
      </div>
      {!shown ? (
        <aside
          aria-label="Collapsed terminal tabs"
          className="flex w-10 shrink-0 items-start justify-center border-r pt-2"
          style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
        >
          <button
            ref={expandButtonRef}
            type="button"
            aria-label="Show terminal tabs"
            aria-controls={sidebarId}
            aria-expanded="false"
            title="Show terminal tabs"
            className="no-drag flex size-9 shrink-0 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
            onClick={() => toggle(true)}
          >
            <PanelLeftOpenIcon size={15} aria-hidden="true" />
          </button>
        </aside>
      ) : null}
      {children}
    </OSWindowSafeView>
  );
}

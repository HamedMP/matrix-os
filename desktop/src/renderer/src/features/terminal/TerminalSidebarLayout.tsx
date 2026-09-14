import {
  type ReactNode,
  type Ref,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { OSWindowSafeView } from "../desktop-shell/OSWindow";

interface SidebarControls {
  sidebarId: string;
  collapseButtonRef: Ref<HTMLButtonElement>;
  shown: boolean;
  onCollapse: () => void;
  onToggle: () => void;
}

/** Keep one header and the mounted terminal buffers when toggling the session list. */
export function TerminalSidebarLayout({
  header,
  sidebar,
  children,
}: {
  header: (controls: SidebarControls) => ReactNode;
  sidebar: (controls: SidebarControls) => ReactNode;
  children: ReactNode;
}) {
  const sidebarId = useId();
  const [shown, setShown] = useState(true);
  const collapseButtonRef = useRef<HTMLButtonElement>(null);
  const focusAfterToggle = useRef(false);
  const toggle = (next: boolean) => {
    focusAfterToggle.current = true;
    setShown(next);
  };
  useLayoutEffect(() => {
    if (!focusAfterToggle.current) return;
    focusAfterToggle.current = false;
    collapseButtonRef.current?.focus();
  }, [shown]);
  const controls = {
    sidebarId,
    collapseButtonRef,
    shown,
    onCollapse: () => toggle(false),
    onToggle: () => toggle(!shown),
  };
  return (
    <OSWindowSafeView
      area="sidebar"
      data-testid="desktop-terminal-app"
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      style={{ background: "var(--bg-app)", color: "var(--text-primary)" }}
    >
      <header
        aria-label="Terminal toolbar"
        className="matrix-terminal-app-header flex h-12 shrink-0 items-center justify-between border-b"
        style={{
          borderColor: "var(--border-subtle)",
          background: "var(--bg-surface)",
        }}
      >
        {header(controls)}
      </header>
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div
          id={sidebarId}
          data-terminal-tabs-sidebar
          hidden={!shown}
          className={
            shown
              ? "w-[280px] min-w-[200px] max-w-[280px] shrink-0 border-r"
              : "hidden"
          }
          style={{ borderColor: "var(--border-subtle)" }}
        >
          {sidebar(controls)}
        </div>
        {children}
      </div>
    </OSWindowSafeView>
  );
}

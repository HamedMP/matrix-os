import { ChevronRight } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

export function sidebarNavRowStyle(active: boolean): CSSProperties {
  return {
    height: "var(--sidebar-row-height)",
    color: active ? "var(--text-primary)" : "var(--text-secondary)",
    background: active ? "var(--bg-surface)" : undefined,
    boxShadow: active ? "inset 0 0 0 1px var(--border-subtle)" : undefined,
    fontWeight: active ? 500 : 400,
  };
}

export function SidebarIcon({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      data-sidebar-icon
      className="flex shrink-0 items-center justify-center transition-colors [&>svg]:size-3.5"
      style={{
        width: "14px",
        height: "14px",
        color: active ? "var(--text-primary)" : "var(--text-tertiary)",
      }}
    >
      {children}
    </span>
  );
}

export function SidebarDivider() {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      className="h-px shrink-0"
      style={{
        marginInline: "16px",
        background: "var(--sidebar-divider)",
      }}
    />
  );
}

export function SidebarNavRow({
  icon,
  label,
  active,
  badge,
  collapsed,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  badge?: number;
  collapsed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={badge ? `${label} ${badge}` : label}
      aria-current={active ? "page" : undefined}
      data-active={active ? "true" : "false"}
      title={collapsed ? label : undefined}
      className={`group/sidebar-row flex w-full items-center rounded-md text-[13px] outline-none transition-colors duration-100 hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)] ${collapsed ? "justify-center px-0" : "gap-2 px-2"}`}
      style={sidebarNavRowStyle(active)}
      onClick={onClick}
    >
      <SidebarIcon active={active}>{icon}</SidebarIcon>
      {!collapsed ? <span className="min-w-0 flex-1 truncate text-left">{label}</span> : null}
      {!collapsed && badge ? (
        <span
          aria-hidden="true"
          className="min-w-5 rounded-full px-1.5 text-center text-xs"
          style={{ background: "var(--highlight-muted)", color: "var(--highlight)" }}
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}

export function SidebarSectionHeader({
  label,
  open,
  controls,
  onToggle,
  action,
}: {
  label: string;
  open: boolean;
  controls: string;
  onToggle: () => void;
  action?: ReactNode;
}) {
  return (
    <div className="group/sidebar-section mt-4 mb-1 flex items-center px-2.5">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={controls}
        className="flex min-w-0 flex-1 items-center gap-1 rounded-sm text-left outline-none"
        onClick={onToggle}
      >
        <ChevronRight
          size={12}
          aria-hidden="true"
          className="shrink-0 transition-transform duration-100"
          style={{ color: "var(--text-tertiary)", transform: open ? "rotate(90deg)" : undefined }}
        />
        <span className="truncate text-xs font-semibold tracking-wide uppercase" style={{ color: "var(--text-tertiary)" }}>
          {label}
        </span>
      </button>
      {action}
    </div>
  );
}

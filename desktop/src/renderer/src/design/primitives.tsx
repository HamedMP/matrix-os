// UI primitives on the token system, built on Radix for focus management,
// dismissal, and accessibility.
import * as RadixContextMenu from "@radix-ui/react-context-menu";
import * as RadixDialog from "@radix-ui/react-dialog";
import * as RadixTooltip from "@radix-ui/react-tooltip";
import type { CSSProperties, ReactNode, ButtonHTMLAttributes } from "react";

type ButtonVariant = "primary" | "ghost" | "danger" | "subtle";

const BUTTON_STYLES: Record<ButtonVariant, CSSProperties> = {
  primary: { background: "var(--accent)", color: "var(--text-on-accent)" },
  ghost: { background: "transparent", color: "var(--text-secondary)" },
  subtle: { background: "var(--bg-hover)", color: "var(--text-primary)" },
  danger: { background: "var(--danger-muted)", color: "var(--danger)" },
};

export function Button({
  variant = "subtle",
  className = "",
  style,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type="button"
      className={`no-drag inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors duration-100 hover:brightness-105 disabled:opacity-50 ${className}`}
      style={{ ...BUTTON_STYLES[variant], ...style }}
      {...props}
    />
  );
}

export function IconButton({
  label,
  className = "",
  active = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  const button = (
    <button
      type="button"
      aria-label={label}
      className={`no-drag inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors duration-100 ${className}`}
      style={{
        color: active ? "var(--accent)" : "var(--text-tertiary)",
        background: active ? "var(--accent-muted)" : "transparent",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = "transparent";
      }}
      {...props}
    />
  );
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{button}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          sideOffset={6}
          className="z-[100] rounded-md px-2 py-1 text-xs"
          style={{ background: "var(--forest-deep)", color: "var(--forest-foreground)", boxShadow: "var(--shadow-2)" }}
        >
          {label}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}

export function Dialog({
  open,
  onClose,
  children,
  width = 480,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50" style={{ background: "rgba(40,44,37,0.35)" }} />
        <RadixDialog.Content
          aria-describedby={undefined}
          className="fade-in fixed top-[18vh] left-1/2 z-50 -translate-x-1/2 rounded-xl border focus:outline-none"
          style={{ width, background: "var(--bg-overlay)", borderColor: "var(--border-default)", boxShadow: "var(--shadow-3)" }}
        >
          <RadixDialog.Title className="sr-only">Dialog</RadixDialog.Title>
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export interface MenuItem {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

// Right-click context menu: wrap the trigger content; pass the items.
export function ContextMenu({ items, children }: { items: MenuItem[]; children: ReactNode }) {
  return (
    <RadixContextMenu.Root>
      <RadixContextMenu.Trigger asChild>{children}</RadixContextMenu.Trigger>
      <RadixContextMenu.Portal>
        <RadixContextMenu.Content
          className="fade-in z-[100] min-w-[180px] rounded-lg border p-1"
          style={{ background: "var(--bg-overlay)", borderColor: "var(--border-default)", boxShadow: "var(--shadow-2)" }}
        >
          {items.map((item) => (
            <RadixContextMenu.Item
              key={item.label}
              disabled={item.disabled}
              onSelect={item.onSelect}
              className="flex cursor-default items-center rounded-md px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-[var(--bg-hover)] data-[disabled]:opacity-40"
              style={{ color: item.danger ? "var(--danger)" : "var(--text-primary)" }}
            >
              {item.label}
            </RadixContextMenu.Item>
          ))}
        </RadixContextMenu.Content>
      </RadixContextMenu.Portal>
    </RadixContextMenu.Root>
  );
}

export function StatusDot({ color, pulse = false }: { color: string; pulse?: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${pulse ? "status-pulse" : ""}`}
      style={{ background: color }}
    />
  );
}

export function EmptyState({
  icon,
  headline,
  description,
  action,
}: {
  icon: ReactNode;
  headline: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8">
      <div style={{ color: "var(--text-tertiary)" }}>{icon}</div>
      <h2 className="text-md font-semibold" style={{ color: "var(--text-primary)" }}>{headline}</h2>
      <p className="max-w-[320px] text-center text-sm" style={{ color: "var(--text-secondary)" }}>{description}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

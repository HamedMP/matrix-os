import {
  ChevronRight,
  CircleHelp,
  CreditCard,
  LogOut,
  Settings,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { invoke } from "../../lib/operator";
import { useConnection } from "../../stores/connection";
import { useTabs } from "../../stores/tabs";
import { useUi } from "../../stores/ui";

function AccountAvatar({
  imageUrl,
  label,
}: {
  imageUrl: string | null;
  label: string;
}) {
  const [failed, setFailed] = useState(false);

  if (imageUrl && !failed) {
    return (
      <img
        src={imageUrl}
        alt=""
        className="h-full w-full object-cover"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }
  return <>{label.charAt(0).toUpperCase()}</>;
}

function MenuRow({
  icon,
  label,
  onClick,
  trailing = false,
  danger = false,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  trailing?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-[var(--bg-hover)]"
      style={{ color: danger ? "var(--danger)" : "var(--text-primary)" }}
      onClick={onClick}
    >
      <span style={{ color: danger ? "var(--danger)" : "var(--text-tertiary)" }}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing ? <ChevronRight size={13} style={{ color: "var(--text-tertiary)" }} /> : null}
    </button>
  );
}

export default function AccountMenu({ collapsed }: { collapsed: boolean }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const handle = useConnection((state) => state.handle);
  const displayName = useConnection((state) => state.displayName);
  const imageUrl = useConnection((state) => state.imageUrl);
  const signOut = useConnection((state) => state.signOut);
  const openTab = useTabs((state) => state.openTab);
  const requestSettingsSection = useUi((state) => state.requestSettingsSection);
  const primaryLabel = displayName ?? (handle ? `@${handle}` : "Signed in");
  const secondaryLabel = displayName && handle ? `@${handle}` : null;

  useEffect(() => {
    if (!open) return;
    const closeOnPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const openSettings = (section: "account" | "billing") => {
    setOpen(false);
    requestSettingsSection(section);
    openTab({ kind: "settings", title: "Settings" });
  };

  return (
    <div ref={rootRef} className="relative p-2 pt-1">
      {open ? (
        <div
          role="menu"
          aria-label="Account"
          className="absolute bottom-full left-2 mb-1 w-56 rounded-xl border p-1 shadow-lg"
          style={{ zIndex: 30, borderColor: "var(--border-default)", background: "var(--bg-overlay)" }}
        >
          <div className="px-2 py-2">
            <span className="block text-[10px] font-semibold uppercase tracking-[0.1em]" style={{ color: "var(--text-tertiary)" }}>
              Personal account
            </span>
            <span className="block truncate text-xs" style={{ color: "var(--text-secondary)" }}>
              {secondaryLabel ?? primaryLabel}
            </span>
          </div>
          <div className="border-t p-1" style={{ borderColor: "var(--border-subtle)" }}>
            <MenuRow icon={<Settings size={14} />} label="Settings" trailing onClick={() => openSettings("account")} />
            <MenuRow
              icon={<CircleHelp size={14} />}
              label="Get help"
              trailing
              onClick={() => {
                setOpen(false);
                void invoke("shell:open-external", { url: "https://matrix-os.com/docs" });
              }}
            />
          </div>
          <div className="border-t p-1" style={{ borderColor: "var(--border-subtle)" }}>
            <MenuRow icon={<CreditCard size={14} />} label="View all plans" onClick={() => openSettings("billing")} />
          </div>
          <div className="border-t p-1" style={{ borderColor: "var(--border-subtle)" }}>
            <MenuRow
              icon={<LogOut size={14} />}
              label="Log out"
              danger
              onClick={() => {
                setOpen(false);
                void signOut().catch((error: unknown) => {
                  console.warn(
                    "[account-menu] sign-out failed:",
                    error instanceof Error ? error.message : String(error),
                  );
                });
              }}
            />
          </div>
        </div>
      ) : null}

      <button
        type="button"
        aria-label="Open account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        title={collapsed ? primaryLabel : undefined}
        className={`flex w-full items-center rounded-md hover:bg-[var(--bg-hover)] ${collapsed ? "h-9 justify-center" : "gap-2 px-1 py-1"}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full text-xs font-semibold"
          style={{ background: "var(--accent-muted)", color: "var(--accent)" }}
        >
          <AccountAvatar key={imageUrl} imageUrl={imageUrl} label={primaryLabel} />
        </span>
        {!collapsed ? (
          <span className="min-w-0 flex-1 text-left leading-tight">
            <span className="block truncate text-sm" style={{ color: "var(--text-primary)" }}>{primaryLabel}</span>
            {secondaryLabel ? (
              <span className="block truncate text-xs" style={{ color: "var(--text-tertiary)" }}>{secondaryLabel}</span>
            ) : null}
          </span>
        ) : null}
      </button>
    </div>
  );
}

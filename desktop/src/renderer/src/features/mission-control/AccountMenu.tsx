import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ChevronRight,
  CircleHelp,
  CreditCard,
  LogOut,
  Settings,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { DESKTOP_Z_INDEX } from "../../design/layering";
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
  onSelect,
  trailing = false,
  danger = false,
}: {
  icon: React.ReactNode;
  label: string;
  onSelect: () => void;
  trailing?: boolean;
  danger?: boolean;
}) {
  return (
    <DropdownMenu.Item
      className="flex h-9 cursor-default items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none data-[highlighted]:bg-[var(--bg-hover)]"
      style={{ color: danger ? "var(--danger)" : "var(--text-primary)" }}
      onSelect={onSelect}
    >
      <span aria-hidden="true" style={{ color: danger ? "var(--danger)" : "var(--text-tertiary)" }}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing ? <ChevronRight aria-hidden="true" size={13} style={{ color: "var(--text-tertiary)" }} /> : null}
    </DropdownMenu.Item>
  );
}

export default function AccountMenu({
  collapsed,
  trailingAction = null,
}: {
  collapsed: boolean;
  trailingAction?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const handle = useConnection((state) => state.handle);
  const displayName = useConnection((state) => state.displayName);
  const imageUrl = useConnection((state) => state.imageUrl);
  const signOut = useConnection((state) => state.signOut);
  const openTab = useTabs((state) => state.openTab);
  const requestSettingsSection = useUi((state) => state.requestSettingsSection);
  const primaryLabel = displayName ?? (handle ? `@${handle}` : "Signed in");
  const secondaryLabel = displayName && handle ? `@${handle}` : null;

  const openSettings = (section: "account" | "billing") => {
    setOpen(false);
    requestSettingsSection(section);
    openTab({ kind: "settings", title: "Settings" });
  };

  return (
    <div className={`p-2 pt-1 ${collapsed ? "" : "flex items-center gap-1"}`}>
      <DropdownMenu.Root open={open} onOpenChange={setOpen}>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label="Open account menu"
            title={collapsed ? primaryLabel : undefined}
            className={`flex h-10 min-w-0 items-center rounded-md outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)] ${collapsed ? "w-full justify-center" : "flex-1 gap-2 px-1"}`}
          >
            <span
              className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full text-xs font-semibold"
              style={{ background: "var(--accent-muted)", color: "var(--accent)" }}
            >
              <AccountAvatar key={imageUrl} imageUrl={imageUrl} label={primaryLabel} />
            </span>
            {!collapsed ? (
              <span className="min-w-0 flex-1 text-left leading-tight">
                <span className="block truncate text-sm font-medium" style={{ color: "var(--text-primary)" }}>{primaryLabel}</span>
                {secondaryLabel ? (
                  <span className="block truncate text-xs" style={{ color: "var(--text-tertiary)" }}>{secondaryLabel}</span>
                ) : null}
              </span>
            ) : null}
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            aria-label="Account"
            aria-labelledby={undefined}
            side="top"
            align="start"
            sideOffset={4}
            className="rounded-xl border p-1 outline-none"
            style={{
              zIndex: DESKTOP_Z_INDEX.popover,
              width: "var(--sidebar-account-menu-width)",
              borderColor: "var(--border-default)",
              background: "var(--bg-overlay)",
              boxShadow: "var(--shadow-2)",
            }}
          >
            <DropdownMenu.Label className="px-2 py-2">
              <span className="block text-[10px] font-semibold uppercase tracking-[0.1em]" style={{ color: "var(--text-tertiary)" }}>
                Personal account
              </span>
              <span className="block truncate text-xs" style={{ color: "var(--text-secondary)" }}>
                {secondaryLabel ?? primaryLabel}
              </span>
            </DropdownMenu.Label>
            <DropdownMenu.Separator className="my-1 h-px" style={{ background: "var(--border-subtle)" }} />
            <MenuRow icon={<Settings size={14} />} label="Settings" trailing onSelect={() => openSettings("account")} />
            <MenuRow
              icon={<CircleHelp size={14} />}
              label="Get help"
              trailing
              onSelect={() => {
                setOpen(false);
                void invoke("shell:open-external", { url: "https://matrix-os.com/docs" });
              }}
            />
            <DropdownMenu.Separator className="my-1 h-px" style={{ background: "var(--border-subtle)" }} />
            <MenuRow icon={<CreditCard size={14} />} label="View all plans" onSelect={() => openSettings("billing")} />
            <DropdownMenu.Separator className="my-1 h-px" style={{ background: "var(--border-subtle)" }} />
            <MenuRow
              icon={<LogOut size={14} />}
              label="Log out"
              danger
              onSelect={() => {
                setOpen(false);
                void signOut().catch((error: unknown) => {
                  console.warn(
                    "[account-menu] sign-out failed:",
                    error instanceof Error ? error.message : String(error),
                  );
                });
              }}
            />
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {trailingAction}
    </div>
  );
}

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ChevronRight,
  CircleHelp,
  CreditCard,
  LogOut,
  Settings,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
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
      className="flex h-9 cursor-default items-center gap-2 px-2 text-left text-[13px] outline-none data-[highlighted]:bg-[var(--bg-hover)]"
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
  compact = false,
  trailingAction = null,
}: {
  collapsed: boolean;
  compact?: boolean;
  trailingAction?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const handle = useConnection((state) => state.handle);
  const displayName = useConnection((state) => state.displayName);
  const imageUrl = useConnection((state) => state.imageUrl);
  const signOut = useConnection((state) => state.signOut);
  const openTab = useTabs((state) => state.openTab);
  const requestSettingsSection = useUi((state) => state.requestSettingsSection);
  const acquireRendererOverlay = useUi((state) => state.acquireRendererOverlay);
  const releaseRendererOverlay = useUi((state) => state.releaseRendererOverlay);
  const primaryLabel = displayName ?? (handle ? `@${handle}` : "Signed in");
  const secondaryLabel = displayName && handle ? `@${handle}` : null;

  useEffect(() => {
    if (!open) return;
    acquireRendererOverlay();
    return releaseRendererOverlay;
  }, [acquireRendererOverlay, open, releaseRendererOverlay]);

  const openSettings = (section: "account" | "billing") => {
    setOpen(false);
    requestSettingsSection(section);
    openTab({ kind: "settings", title: "Settings" });
  };

  return (
    <div className={compact ? "flex items-center" : collapsed ? "p-2 pt-1" : "flex items-center gap-1 px-4 py-4"}>
      <DropdownMenu.Root open={open} onOpenChange={setOpen}>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label="Open account menu"
            title={collapsed ? primaryLabel : undefined}
            className={`flex min-w-0 items-center rounded-md outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)] ${compact ? "size-7 justify-center" : collapsed ? "h-10 w-full justify-center" : "flex-1 gap-2"}`}
          >
            <span
              className={`flex shrink-0 items-center justify-center overflow-hidden rounded-full text-xs font-semibold ${compact ? "size-6" : "h-7 w-7"}`}
              style={{ background: "var(--accent-muted)", color: "var(--accent)" }}
            >
              <AccountAvatar key={imageUrl} imageUrl={imageUrl} label={primaryLabel} />
            </span>
            {!collapsed ? (
              <span className="min-w-0 flex-1 text-left leading-tight">
                <span className="block truncate text-xs font-semibold" style={{ color: "var(--text-primary)" }}>{primaryLabel}</span>
                {secondaryLabel ? (
                  <span className="block truncate text-[10px]" style={{ color: "var(--text-tertiary)" }}>{secondaryLabel}</span>
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
            className="border p-1 outline-none"
            style={{
              zIndex: DESKTOP_Z_INDEX.popover,
              width: "var(--sidebar-account-menu-width)",
              borderColor: "var(--border-default)",
              background: "var(--bg-overlay)",
              boxShadow: "var(--shadow-2)",
              borderRadius: "12px",
              overflow: "hidden",
            }}
          >
            <DropdownMenu.Label className="px-2 py-2">
              <span
                className="block text-secondary"
                style={{
                  color: "var(--text-subtle, #96968F)",
                  fontSize: "10px",
                  fontWeight: 600,
                  letterSpacing: "0.005px",
                  textTransform: "uppercase",
                }}
              >
                Personal account
              </span>
              <span className="block truncate">
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
            <MenuRow icon={<CreditCard size={14} />} label="View plans" onSelect={() => openSettings("billing")} />
            <DropdownMenu.Separator className="my-1 h-px" style={{ background: "var(--border-subtle)" }} />
            <MenuRow
              icon={<LogOut size={14} />}
              label="Logout"
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

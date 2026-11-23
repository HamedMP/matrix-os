import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ChevronRight,
  ClipboardCheck,
  CreditCard,
  ExternalLink,
  LogOut,
  Settings,
  Sparkles,
} from "@renderer/lib/hugeicons";
import { DiscordIcon, GettingStartedMenuSummary, useGettingStartedProgress } from "@matrix-os/ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { DesktopOrganizationMenuItems } from "./DesktopOrganizationMenuItems";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import { useConnection } from "../../stores/connection";
import { useTabs } from "../../stores/tabs";
import { useUi } from "../../stores/ui";

const DISCORD_INVITE_URL = "https://discord.gg/WHbvTG33w";

/** What's New entry point; the owner of release notes decides what "unseen" means. */
export interface AccountMenuWhatsNew {
  unseen: boolean;
  open(): void;
}

function UnseenDot({ testId, className }: { testId: string; className: string }) {
  return <span data-testid={testId} aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${className}`} style={{ background: "var(--accent)" }} />;
}

const MENU_ROW_CLASS = "flex h-9 cursor-default items-center gap-2 px-2 text-left text-[13px] outline-none data-[highlighted]:bg-[var(--bg-hover)]";

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
      className={MENU_ROW_CLASS}
      style={{ color: danger ? "var(--danger-text)" : "var(--text-primary)" }}
      onSelect={onSelect}
    >
      <span aria-hidden="true" style={{ color: danger ? "var(--danger-text)" : "var(--text-tertiary)" }}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing ? <ChevronRight aria-hidden="true" size={13} style={{ color: "var(--text-tertiary)" }} /> : null}
    </DropdownMenu.Item>
  );
}


function AccountMenuTrigger({
  collapsed,
  compact,
  imageUrl,
  primaryLabel,
  secondaryLabel,
  unseen,
}: {
  collapsed: boolean;
  compact: boolean;
  imageUrl: string | null;
  primaryLabel: string;
  secondaryLabel: string | null;
  unseen: boolean;
}) {
  return <DropdownMenu.Trigger asChild>
    <button
      type="button"
      aria-label="Open account menu"
      aria-description={unseen ? "New release notes" : undefined}
      title={collapsed ? primaryLabel : undefined}
      className={`relative flex min-w-0 items-center rounded-md outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)] ${compact ? "size-7 justify-center" : collapsed ? "h-10 w-full justify-center" : "flex-1 gap-2"}`}
    >
      <span
        className={`flex shrink-0 items-center justify-center overflow-hidden rounded-full text-xs font-semibold ${compact ? "size-6" : "h-7 w-7"}`}
        style={{ background: "var(--accent-muted)", color: "var(--accent-text)" }}
      >
        <AccountAvatar key={imageUrl} imageUrl={imageUrl} label={primaryLabel} />
      </span>
      {unseen ? <UnseenDot testId="account-unseen-dot" className="absolute right-0 top-0" /> : null}
      {!collapsed ? <span className="min-w-0 flex-1 text-left leading-tight">
        <span className="block truncate text-xs font-semibold" style={{ color: "var(--text-primary)" }}>{primaryLabel}</span>
        {secondaryLabel ? <span className="block truncate text-[10px]" style={{ color: "var(--text-tertiary)" }}>{secondaryLabel}</span> : null}
      </span> : null}
    </button>
  </DropdownMenu.Trigger>;
}

/** Shown only while setup is unfinished; opens the top bar's Getting started checklist. */
function GettingStartedMenuRow({ onOpen }: { onOpen(): void }) {
  const gettingStarted = useGettingStartedProgress();
  if (!gettingStarted || gettingStarted.completed >= gettingStarted.total) return null;
  return <>
    <DropdownMenu.Item
      className="flex cursor-default items-start gap-2 px-2 py-2 text-left text-[13px] outline-none data-[highlighted]:bg-[var(--bg-hover)]"
      style={{ color: "var(--text-primary)" }}
      onSelect={() => {
        onOpen();
        gettingStarted.open();
      }}
    >
      <ClipboardCheck aria-hidden="true" size={14} className="mt-0.5 shrink-0" style={{ color: "var(--text-tertiary)" }} />
      <GettingStartedMenuSummary completed={gettingStarted.completed} total={gettingStarted.total} next={gettingStarted.next} />
    </DropdownMenu.Item>
    <DropdownMenu.Separator className="my-1 h-px" style={{ background: "var(--border-subtle)" }} />
  </>;
}

function ReleaseAndCommunityRows({ whatsNew, onSelect }: { whatsNew?: AccountMenuWhatsNew; onSelect(): void }) {
  return <>
    {whatsNew ? <DropdownMenu.Item
      className={MENU_ROW_CLASS}
      style={{ color: "var(--text-primary)" }}
      onSelect={() => {
        onSelect();
        whatsNew.open();
      }}
    >
      <span aria-hidden="true" style={{ color: "var(--text-tertiary)" }}><Sparkles size={14} /></span>
      <span className="min-w-0 flex-1 truncate">What&apos;s New</span>
      {whatsNew.unseen ? <UnseenDot testId="whats-new-unseen-dot" className="" /> : null}
    </DropdownMenu.Item> : null}
    <DropdownMenu.Item asChild>
      <a className={MENU_ROW_CLASS} style={{ color: "var(--text-primary)" }} href={DISCORD_INVITE_URL} target="_blank" rel="noopener noreferrer">
        <DiscordIcon size={14} className="shrink-0" style={{ color: "var(--text-tertiary)" }} />
        <span className="min-w-0 flex-1 truncate">Join Discord</span>
        <ExternalLink aria-hidden="true" size={12} style={{ color: "var(--text-tertiary)" }} />
      </a>
    </DropdownMenu.Item>
  </>;
}

export default function AccountMenu({
  collapsed,
  compact = false,
  trailingAction = null,
  whatsNew,
}: {
  collapsed: boolean;
  compact?: boolean;
  trailingAction?: ReactNode;
  whatsNew?: AccountMenuWhatsNew;
}) {
  const [open, setOpen] = useState(false);
  // Opening the checklist moves focus into it; the closing menu must not pull focus back.
  const keepFocusOnClose = useRef(false);
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
        <AccountMenuTrigger collapsed={collapsed} compact={compact} imageUrl={imageUrl}
          primaryLabel={primaryLabel} secondaryLabel={secondaryLabel} unseen={whatsNew?.unseen ?? false} />
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            aria-label="Account"
            aria-labelledby={undefined}
            side={compact ? "bottom" : "top"}
            align={compact ? "end" : "start"}
            sideOffset={4}
            onCloseAutoFocus={(event) => {
              if (!keepFocusOnClose.current) return;
              keepFocusOnClose.current = false;
              event.preventDefault();
            }}
            className="border p-1 outline-none"
            style={{
              zIndex: DESKTOP_Z_INDEX.popover,
              width: "var(--sidebar-account-menu-width)",
              borderColor: "var(--border-default)",
              background: "var(--bg-overlay)",
              boxShadow: "var(--shadow-2)",
              borderRadius: "12px",
              maxHeight: "var(--radix-dropdown-menu-content-available-height)",
              overflowY: "auto",
              overflowX: "hidden",
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
            <GettingStartedMenuRow onOpen={() => {
              keepFocusOnClose.current = true;
              setOpen(false);
            }} />
            <DesktopOrganizationMenuItems itemClass={MENU_ROW_CLASS} />
            <MenuRow icon={<Settings size={14} />} label="Settings" trailing onSelect={() => openSettings("account")} />
            <MenuRow icon={<CreditCard size={14} />} label="View plans" onSelect={() => openSettings("billing")} />
            <ReleaseAndCommunityRows whatsNew={whatsNew} onSelect={() => setOpen(false)} />
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

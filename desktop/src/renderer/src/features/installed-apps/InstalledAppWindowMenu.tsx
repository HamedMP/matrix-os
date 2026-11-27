import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useEffect, useState } from "react";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import { Button } from "../../design/primitives";
import { MoreHorizontal } from "../../lib/hugeicons";
import { useConnection } from "../../stores/connection";
import { useUi } from "../../stores/ui";
import { appIconUrl, useAppsQuery } from "../apps/apps.api";
import { useInstallAppFlow } from "./use-install-app-flow";

/** The app window's "More" menu in Electron Desktop: Install as App… or Uninstall App…. Hidden when installing is unavailable. */
export function InstalledAppWindowMenu({ slug, portalContainer }: { slug: string; portalContainer?: HTMLElement | null }) {
  const { data: apps } = useAppsQuery();
  const platformHost = useConnection((state) => state.platformHost);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const acquire = useUi((state) => state.acquireRendererOverlay);
  const release = useUi((state) => state.releaseRendererOverlay);
  const flow = useInstallAppFlow();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!menuOpen) return undefined;
    acquire();
    return release;
  }, [acquire, menuOpen, release]);

  const app = apps?.find((candidate) => candidate.slug === slug);
  const action = app ? flow.actionFor({
    slug: app.slug,
    name: app.name,
    ...(app.path ? { path: app.path } : {}),
    iconUrl: appIconUrl(platformHost, app, runtimeSlot),
  }) : null;
  if (!app || !action) return null;
  return (
    <>
      <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenu.Trigger asChild>
          <Button
            variant="subtle"
            aria-label={`More actions for ${app.name}`}
            title="More"
            style={{ height: 28, width: 28, padding: 0, justifyContent: "center", background: "var(--bg-app)", color: "var(--text-primary)", border: "1px solid var(--border-default)", boxShadow: "var(--shadow-1)" }}
          >
            <MoreHorizontal size={15} aria-hidden="true" />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal container={portalContainer ?? undefined}>
          <DropdownMenu.Content
            align="end"
            sideOffset={4}
            className="min-w-[200px] rounded-xl border p-1 outline-none"
            style={{ zIndex: DESKTOP_Z_INDEX.popover, background: "var(--bg-overlay)", borderColor: "var(--border-default)", boxShadow: "var(--shadow-2)" }}
          >
            <DropdownMenu.Item
              onSelect={action.onSelect}
              className="flex cursor-default items-center rounded-md px-3 py-2 text-sm outline-none data-[highlighted]:bg-[var(--bg-hover)]"
              style={{ color: action.danger ? "var(--danger-text)" : "var(--text-primary)" }}
            >
              {action.label}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {flow.dialog}
    </>
  );
}

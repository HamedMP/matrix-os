// One Install / Uninstall flow for every entry point (app window menu, launcher
// context menu, Settings): it picks the right menu item for an app, runs the
// confirm sheet, and changes renderer state only after main reports success.
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { invoke } from "../../lib/operator";
import { useConnection } from "../../stores/connection";
import { useUi } from "../../stores/ui";
import type { InstalledAppSummary, InstalledAppsList } from "../../../../shared/installed-apps-ipc";
import { InstallAppDialog, type InstallAppDialogRequest } from "./InstallAppDialog";
import { REVEAL_LABEL, installErrorCopy, installRequestFor, installedAppFor, refreshInstalledApps, useInstalledApps } from "./installed-apps";

export interface InstallAppTarget {
  slug: string;
  name: string;
  path?: string;
  iconUrl: string | null;
}

export interface InstallAppAction {
  label: string;
  danger: boolean;
  onSelect: () => void;
}

type Pending =
  | { mode: "install"; target: InstallAppTarget }
  | { mode: "uninstall"; app: InstalledAppSummary; iconUrl: string | null };

function failure(label: string, error: unknown): string {
  console.warn(`[installed-apps] ${label}:`, error instanceof Error ? error.name : "UnknownError");
  return installErrorCopy("failed");
}

export function useInstallAppFlow(): {
  list: InstalledAppsList | undefined;
  actionFor: (target: InstallAppTarget) => InstallAppAction | null;
  requestUninstall: (app: InstalledAppSummary, iconUrl: string | null) => void;
  dialog: ReactNode;
} {
  const list = useInstalledApps();
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const acquire = useUi((state) => state.acquireRendererOverlay);
  const release = useUi((state) => state.releaseRendererOverlay);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = pending !== null;
  // Native app views paint above the renderer; hold them back while the sheet is up.
  useEffect(() => {
    if (!open) return undefined;
    acquire();
    return release;
  }, [acquire, open, release]);

  const show = (next: Pending) => {
    setError(null);
    setPending(next);
  };

  const requestUninstall = (app: InstalledAppSummary, iconUrl: string | null) => show({ mode: "uninstall", app, iconUrl });

  const actionFor = (target: InstallAppTarget): InstallAppAction | null => {
    if (!list?.available) return null;
    const installed = installedAppFor(list, target.slug, runtimeSlot);
    if (installed) return { label: "Uninstall App…", danger: true, onSelect: () => requestUninstall(installed, target.iconUrl) };
    if (!installRequestFor(target)) return null;
    return { label: "Install as App…", danger: false, onSelect: () => show({ mode: "install", target }) };
  };

  const platform = list?.available ? list.platform : null;

  async function install(target: InstallAppTarget): Promise<void> {
    const request = installRequestFor(target);
    if (!request) {
      setError(installErrorCopy("not-found"));
      return;
    }
    const result = await invoke("installed-apps:install", request);
    if (!result.ok) {
      setError(installErrorCopy(result.error));
      return;
    }
    await refreshInstalledApps();
    setPending(null);
    const { installId, name } = result.app;
    toast.success(`Installed ${name}`, platform === "mac" ? {
      action: {
        label: REVEAL_LABEL.mac,
        onClick: () => {
          void invoke("installed-apps:show", { installId }).catch((cause: unknown) => failure("reveal failed", cause));
        },
      },
    } : undefined);
  }

  async function uninstall(app: InstalledAppSummary): Promise<void> {
    const result = await invoke("installed-apps:uninstall", { installId: app.installId });
    if (!result.ok) {
      setError(installErrorCopy(result.error));
      return;
    }
    await refreshInstalledApps();
    setPending(null);
    toast.success(`Uninstalled ${app.name}`);
  }

  const confirm = async () => {
    if (!pending || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (pending.mode === "install") await install(pending.target);
      else await uninstall(pending.app);
    } catch (cause: unknown) {
      setError(failure(`${pending.mode} request failed`, cause));
    } finally {
      setBusy(false);
    }
  };

  const request: InstallAppDialogRequest | null = !pending ? null : pending.mode === "install"
    ? { mode: "install", name: pending.target.name, iconUrl: pending.target.iconUrl }
    : { mode: "uninstall", name: pending.app.name, iconUrl: pending.iconUrl };

  return {
    list,
    actionFor,
    requestUninstall,
    dialog: platform ? (
      <InstallAppDialog
        request={request}
        platform={platform}
        busy={busy}
        error={error}
        onCancel={() => setPending(null)}
        onConfirm={() => { void confirm(); }}
      />
    ) : null,
  };
}

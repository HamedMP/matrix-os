// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstalledAppWindowMenu } from "../../desktop/src/renderer/src/features/installed-apps/InstalledAppWindowMenu";
import { InstallAppDialog } from "../../desktop/src/renderer/src/features/installed-apps/InstallAppDialog";
import InstalledAppsSection from "../../desktop/src/renderer/src/features/settings/sections/InstalledAppsSection";
import { SettingsSidebar } from "../../desktop/src/renderer/src/features/settings/SettingsView";
import AppLauncher from "../../desktop/src/renderer/src/features/embeds/AppLauncher";
import { installRequestFor, installedAppsQueryKey } from "../../desktop/src/renderer/src/features/installed-apps/installed-apps";
import { desktopQueryClient } from "../../desktop/src/renderer/src/lib/query-client";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";
import type { InstalledAppsList } from "../../desktop/src/shared/installed-apps-ipc";
import { clearDesktopApps, seedDesktopApps } from "./apps-query-test-utils";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const ID = "6f1c2a4e-2b7d-4c1a-9f3e-1a2b3c4d5e6f";
const NOTES = { installId: ID, slug: "notes", appIdentity: "notes", runtimeSlot: "primary", name: "Notes" };

let list: InstalledAppsList;
let handlers: Record<string, (payload: unknown) => unknown>;
let listeners: Map<string, (payload: unknown) => void>;
const invoke = vi.fn(async (channel: string, payload: unknown) => {
  if (channel === "installed-apps:list") return list;
  const handler = handlers[channel];
  if (!handler) throw new Error(`unexpected ${channel}`);
  return handler(payload);
});

beforeEach(() => {
  list = { available: true, platform: "mac", apps: [] };
  handlers = {};
  listeners = new Map();
  window.operator = {
    invoke,
    on: (channel: string, callback: (payload: unknown) => void) => {
      listeners.set(channel, callback);
      return () => listeners.delete(channel);
    },
  };
  useConnection.setState({
    status: "signed-in", handle: "operator", platformHost: "https://platform.test", runtimeSlot: "primary", api: null,
    userId: null, organizationStatus: "none", organizationId: null,
  });
  clearDesktopApps();
  seedDesktopApps([{ slug: "notes", name: "Notes", path: "apps/notes/index.html", appIdentity: "notes" }]);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  invoke.mockClear();
  toast.success.mockClear();
  toast.error.mockClear();
  delete (window as { operator?: unknown }).operator;
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

/** The install list has loaded and every consumer has re-rendered with it. */
const listSettled = async () => {
  await waitFor(() => expect(desktopQueryClient.getQueryState(installedAppsQueryKey)?.status).toBe("success"));
  await act(async () => { await Promise.resolve(); });
};

const openMenu = async (name = "More actions for Notes") => {
  const trigger = await screen.findByRole("button", { name });
  fireEvent.keyDown(trigger, { key: "Enter" });
  return screen.findByRole("menu");
};

describe("install request", () => {
  it("asks main for the app by its catalog identity, never a local path", () => {
    expect(installRequestFor({ slug: "notes", name: "Notes", path: "apps/notes/index.html" })).toEqual({ name: "Notes", path: "matrix-app:notes" });
    expect(installRequestFor({ slug: "my_app", name: "Mine", path: "apps/my_app/index.html" })).toEqual({ name: "Mine", path: "apps/my_app/index.html" });
    expect(installRequestFor({ slug: "my_app", name: "Mine" })).toBeNull();
  });
});

describe("InstallAppDialog", () => {
  it("shows the app, what it can use and where it goes, with Install and Cancel", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<InstallAppDialog request={{ mode: "install", name: "Notes", iconUrl: "/icons/notes.png" }} platform="mac" busy={false} error={null} onCancel={onCancel} onConfirm={onConfirm} />);
    const dialog = screen.getByRole("dialog", { name: "Install Notes?" });
    expect(within(dialog).getByText("Uses the same access it has inside Matrix.")).toBeTruthy();
    expect(within(dialog).getByText(/Applications › Matrix Apps/)).toBeTruthy();
    expect(dialog.querySelector('img[src="/icons/notes.png"]')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Install" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("disables both buttons while working and shows the error", () => {
    render(<InstallAppDialog request={{ mode: "uninstall", name: "Notes", iconUrl: null }} platform="windows" busy error="Couldn’t finish. Try again." onCancel={vi.fn()} onConfirm={vi.fn()} />);
    const dialog = screen.getByRole("alertdialog", { name: "Uninstall Notes?" });
    expect(within(dialog).getByText(/removes it from the Start menu\. Its files and data stay in Matrix/)).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Uninstalling…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByRole("alert").textContent).toBe("Couldn’t finish. Try again.");
  });
});

describe("app window menu", () => {
  it("is hidden when this computer cannot install apps", async () => {
    list = { available: false };
    render(<InstalledAppWindowMenu slug="notes" />);
    await listSettled();
    expect(screen.queryByRole("button", { name: "More actions for Notes" })).toBeNull();
  });

  it("installs from the confirm sheet, then reports it with Show in Finder", async () => {
    handlers["installed-apps:install"] = () => {
      list = { available: true, platform: "mac", apps: [NOTES] };
      return { ok: true, app: NOTES };
    };
    handlers["installed-apps:show"] = () => ({ ok: true });
    render(<InstalledAppWindowMenu slug="notes" />);
    fireEvent.click(within(await openMenu()).getByRole("menuitem", { name: "Install as App…" }));
    expect(useUi.getState().rendererOverlayCount).toBeGreaterThan(0);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Install Notes?" })).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(invoke).toHaveBeenCalledWith("installed-apps:install", { name: "Notes", path: "matrix-app:notes" });
    expect(toast.success).toHaveBeenCalledWith("Installed Notes", expect.objectContaining({ action: expect.objectContaining({ label: "Show in Finder" }) }));
    act(() => { toast.success.mock.calls[0]![1].action.onClick(); });
    expect(invoke).toHaveBeenCalledWith("installed-apps:show", { installId: ID });
    // The refreshed list turns the entry into Uninstall.
    expect(within(await openMenu()).getByRole("menuitem", { name: "Uninstall App…" })).toBeTruthy();
  });

  it("keeps the sheet open with fixed copy when install fails", async () => {
    handlers["installed-apps:install"] = () => ({ ok: false, error: "limit" });
    render(<InstalledAppWindowMenu slug="notes" />);
    fireEvent.click(within(await openMenu()).getByRole("menuitem", { name: "Install as App…" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Install" }));
    expect((await screen.findByRole("alert")).textContent).toBe("You’ve installed the most apps Matrix allows. Uninstall one and try again.");
    expect(screen.getByRole("dialog", { name: "Install Notes?" })).toBeTruthy();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("shows generic copy when the request itself is rejected", async () => {
    handlers["installed-apps:install"] = () => { throw new Error("EACCES /Users/me/Applications"); };
    render(<InstalledAppWindowMenu slug="notes" />);
    fireEvent.click(within(await openMenu()).getByRole("menuitem", { name: "Install as App…" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Install" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn’t finish. Try again.");
  });
});

describe("launcher context menu", () => {
  it("offers Install as App… for a catalog app", async () => {
    render(<AppLauncher />);
    fireEvent.contextMenu(await screen.findByRole("button", { name: "Notes" }));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Install as App…" })).toBeTruthy());
    fireEvent.click(screen.getByRole("menuitem", { name: "Install as App…" }));
    expect(screen.getByRole("dialog", { name: "Install Notes?" })).toBeTruthy();
  });

  it("has no install entry when installing is unavailable", async () => {
    list = { available: false };
    render(<AppLauncher onAddToDesktop={vi.fn()} />);
    await listSettled();
    fireEvent.contextMenu(await screen.findByRole("button", { name: "Notes" }));
    expect(screen.getByRole("menuitem", { name: "Add Notes to Desktop" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /Install as App/ })).toBeNull();
  });
});

describe("Installed apps settings", () => {
  it("is listed in Settings only when installing is available", async () => {
    const { unmount } = render(<SettingsSidebar section="appearance" onSectionChange={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Installed apps" })).toBeTruthy();
    unmount();
    clearDesktopApps();
    list = { available: false };
    render(<SettingsSidebar section="appearance" onSectionChange={vi.fn()} />);
    await listSettled();
    expect(screen.getByRole("button", { name: "Appearance" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Installed apps" })).toBeNull();
  });

  it("shows an empty state that explains how to install", async () => {
    render(<InstalledAppsSection />);
    expect(await screen.findByText("No installed apps")).toBeTruthy();
    expect(screen.getByText(/choose Install as App…/)).toBeTruthy();
  });

  it("opens, reveals and uninstalls an app, removing it only after main succeeds", async () => {
    list = { available: true, platform: "linux", apps: [NOTES] };
    let finish: (value: unknown) => void = () => undefined;
    handlers["installed-apps:open"] = () => ({ ok: true });
    handlers["installed-apps:show"] = () => ({ ok: true });
    handlers["installed-apps:uninstall"] = () => new Promise((resolve) => { finish = resolve; });
    render(<InstalledAppsSection />);
    const row = (await screen.findByText("Notes")).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Open" }));
    fireEvent.click(within(row).getByRole("button", { name: "Show in folder" }));
    expect(invoke).toHaveBeenCalledWith("installed-apps:open", { installId: ID });
    expect(invoke).toHaveBeenCalledWith("installed-apps:show", { installId: ID });
    fireEvent.click(within(row).getByRole("button", { name: "Uninstall Notes" }));
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Uninstall Notes?" })).getByRole("button", { name: "Uninstall" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("installed-apps:uninstall", { installId: ID }));
    // Still listed while main is working.
    expect(screen.getByText("Notes", { selector: "li span" })).toBeTruthy();
    list = { available: true, platform: "linux", apps: [] };
    await act(async () => { finish({ ok: true }); });
    expect(await screen.findByText("No installed apps")).toBeTruthy();
    expect(toast.success).toHaveBeenCalledWith("Uninstalled Notes");
  });

  it("keeps the app listed when uninstall fails", async () => {
    list = { available: true, platform: "windows", apps: [NOTES] };
    handlers["installed-apps:uninstall"] = () => ({ ok: false, error: "failed" });
    render(<InstalledAppsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Uninstall Notes" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Uninstall" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn’t finish. Try again.");
    expect(screen.getByText("Notes", { selector: "li span" })).toBeTruthy();
  });

  it("refreshes when main reports a change", async () => {
    render(<InstalledAppsSection />);
    expect(await screen.findByText("No installed apps")).toBeTruthy();
    list = { available: true, platform: "mac", apps: [NOTES] };
    act(() => listeners.get("installed-apps:changed")?.({}));
    expect(await screen.findByText("Notes", { selector: "li span" })).toBeTruthy();
  });
});

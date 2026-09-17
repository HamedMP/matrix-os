// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DesktopSyncSnapshot } from "@matrix-os/contracts";
import {
  SyncBackupView,
  type SyncBackupTransport,
} from "../../packages/ui/src/sync/SyncBackupView";

function snapshot(overrides: Partial<DesktopSyncSnapshot> = {}): DesktopSyncSnapshot {
  return {
    schemaVersion: 1,
    capability: "available",
    helperVersion: "0.3.16",
    service: "running",
    profile: "desktop",
    runtimeSlot: "primary",
    enabled: true,
    paused: false,
    auth: "ready",
    connection: "online",
    status: "synced",
    activeTransferCount: 0,
    conflictCount: 0,
    lastSyncAt: 1_800_000_000_000,
    mappings: [],
    backup: {
      schemaVersion: 1,
      scheduler: { enabled: true, active: true, nextDueAt: 1_800_003_600_000 },
      lastAttempt: { attemptedAt: 1_800_000_000_000, outcome: "success", errorCode: null },
      lastSuccess: {
        snapshotKey: "backups/snapshot",
        receiptKey: "backups/receipt",
        sha256: "a".repeat(64),
        size: 1024,
        runtimeSlot: "primary",
        completedAt: 1_800_000_000_000,
        restoreVerifiedAt: 1_799_999_000_000,
      },
      storageReachability: "reachable",
      freshness: "healthy",
      observedAt: 1_800_000_000_000,
    },
    backupState: "available",
    ...overrides,
  };
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute("open");
  };
});

afterEach(() => cleanup());

describe("SyncBackupView", () => {
  it("keeps backup health visible in browsers and offers the Desktop handoff", async () => {
    const openDesktop = vi.fn();
    const transport: SyncBackupTransport = {
      localFolderSync: false,
      getSnapshot: vi.fn(async () => snapshot({
        capability: "unsupported_platform",
        helperVersion: null,
        service: "not_configured",
        profile: null,
        runtimeSlot: null,
        enabled: false,
        auth: "unknown",
        connection: "online",
        status: "unavailable",
      })),
      openDesktop,
    };

    render(<SyncBackupView transport={transport} />);

    expect(await screen.findByText("Database backup")).toBeTruthy();
    expect(screen.getByText("Folder sync on this computer requires Matrix Desktop. Backup health remains available here.")).toBeTruthy();
    expect(screen.getByText("healthy")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Matrix Desktop" }));
    expect(openDesktop).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Enable sync" })).toBeNull();
  });

  it("enables a local mapping only from an opaque native folder selection", async () => {
    const enable = vi.fn(async () => snapshot());
    const transport: SyncBackupTransport = {
      localFolderSync: true,
      getSnapshot: vi.fn(async () => snapshot({
        enabled: false,
        status: "not_configured",
        service: "not_configured",
      })),
      chooseFolder: vi.fn(async () => ({
        selectionId: "17ec5dd4-94ce-4ccb-94aa-e6875c43301f",
        displayPath: "/Users/Ada/Documents",
      })),
      enable,
    };

    render(<SyncBackupView transport={transport} />);
    fireEvent.click(await screen.findByRole("button", { name: "Enable sync" }));
    expect((await within(screen.getByRole("dialog", { name: "Set up synced folder" }))
      .findAllByText("/Users/Ada/Documents")).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText("Folder on Matrix"), { target: { value: "/projects/notes/" } });
    fireEvent.click(within(screen.getByRole("dialog", { name: "Set up synced folder" })).getByRole("button", { name: "Enable sync" }));

    await waitFor(() => expect(enable).toHaveBeenCalledWith({
      selectionId: "17ec5dd4-94ce-4ccb-94aa-e6875c43301f",
      remotePrefix: "projects/notes",
      direction: "two_way",
      propagateDeletes: false,
      excludes: [],
    }));
  });

  it("closes setup on Escape and returns focus to its entry point", async () => {
    const transport: SyncBackupTransport = {
      localFolderSync: true,
      getSnapshot: vi.fn(async () => snapshot({
        enabled: false,
        status: "not_configured",
        service: "not_configured",
      })),
      chooseFolder: vi.fn(async () => null),
      enable: vi.fn(async () => snapshot()),
    };

    render(<SyncBackupView transport={transport} />);
    const trigger = await screen.findByRole("button", { name: "Enable sync" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Set up synced folder" });
    screen.getByLabelText("Folder on Matrix").focus();
    expect(document.activeElement).not.toBe(trigger);
    fireEvent(dialog, new Event("cancel", { cancelable: true }));

    await waitFor(() => expect(dialog.hasAttribute("open")).toBe(false));
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps a mapping visible and reports a bounded message when a mutation fails", async () => {
    const current = snapshot({
      mappings: [{
        id: "5a8ee913-b09a-4071-ac99-99436ca30946",
        label: "Documents",
        localRoot: "/Users/Ada/Documents",
        remotePrefix: "documents",
        direction: "two_way",
        enabled: true,
        propagateDeletes: false,
        excludes: [],
        state: "idle",
        fileCount: 12,
        conflictCount: 0,
        lastSuccessfulReconcileAt: 1_800_000_000_000,
        lastIssue: "disk_full",
      }],
    });
    const transport: SyncBackupTransport = {
      localFolderSync: true,
      getSnapshot: vi.fn(async () => current),
      removeMapping: vi.fn(async () => {
        throw new Error("secret provider path /private/customer");
      }),
    };

    render(<SyncBackupView transport={transport} />);
    expect(await screen.findByText("Documents")).toBeTruthy();
    expect(screen.getByText("This disk does not have enough free space to continue syncing.")).toBeTruthy();
    expect(screen.getByText("No configured exclusions")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect((await screen.findByRole("alert")).textContent).toBe("The sync change did not complete. Your folders were left unchanged.");
    expect(screen.getByText("Documents")).toBeTruthy();
    expect(screen.queryByText(/private\/customer/)).toBeNull();
  });

  it("offers credential recovery and reports material connection activity", async () => {
    const reconnecting = snapshot({
      auth: "needs_sign_in",
      connection: "connecting",
      status: "offline",
      activeTransferCount: 2,
      conflictCount: 3,
    });
    const reauthorize = vi.fn(async () => snapshot());

    render(<SyncBackupView transport={{
      localFolderSync: true,
      getSnapshot: vi.fn(async () => reconnecting),
      reauthorize,
    }} />);

    expect(await screen.findByText("Reconnect required")).toBeTruthy();
    expect(screen.getByText("Connecting")).toBeTruthy();
    expect(screen.getByText("2 active transfers")).toBeTruthy();
    expect(screen.getByText("3 conflicts")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect sync" }));
    await waitFor(() => expect(reauthorize).toHaveBeenCalledTimes(1));
  });

  it("converges both add-folder entry points on the same explicit mapping form", async () => {
    const current = snapshot({
      mappings: [{
        id: "5a8ee913-b09a-4071-ac99-99436ca30946",
        label: "Matrix Home",
        localRoot: "/Users/Ada/Matrix",
        remotePrefix: "",
        direction: "two_way",
        enabled: true,
        propagateDeletes: false,
        excludes: [],
        state: "idle",
        fileCount: 12,
        conflictCount: 0,
        lastSuccessfulReconcileAt: 1_800_000_000_000,
      }],
    });
    const addMapping = vi.fn(async () => current);
    const chooseFolder = vi.fn(async () => ({
      selectionId: "17ec5dd4-94ce-4ccb-94aa-e6875c43301f",
      displayPath: "/Users/Ada/Work",
    }));
    render(<SyncBackupView transport={{
      localFolderSync: true,
      getSnapshot: vi.fn(async () => current),
      chooseFolder,
      addMapping,
    }} />);

    fireEvent.click(await screen.findByRole("button", { name: "Folder on this computer" }));
    expect(await screen.findByDisplayValue("projects/Work")).toBeTruthy();
    expect(screen.getByLabelText("Sync preview").textContent).toContain("/Users/Ada/Work");
    fireEvent.click(within(screen.getByRole("dialog", { name: "Set up synced folder" })).getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("button", { name: "Folder on Matrix" }));
    expect(screen.getByDisplayValue("projects/")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Choose a folder" }));
    await within(screen.getByRole("dialog", { name: "Set up synced folder" })).findAllByText("/Users/Ada/Work");
    fireEvent.change(screen.getByLabelText("Folder on Matrix"), { target: { value: "projects/research" } });
    fireEvent.click(within(screen.getByRole("dialog", { name: "Set up synced folder" })).getByRole("button", { name: "Enable sync" }));

    await waitFor(() => expect(addMapping).toHaveBeenCalledWith(expect.objectContaining({
      selectionId: "17ec5dd4-94ce-4ccb-94aa-e6875c43301f",
      remotePrefix: "projects/research",
      direction: "two_way",
      propagateDeletes: false,
    })));
  });
});

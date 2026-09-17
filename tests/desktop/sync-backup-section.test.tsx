// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopSyncSnapshot } from "@matrix-os/contracts";
import SyncBackupSection from "../../desktop/src/renderer/src/features/settings/sections/SyncBackupSection";
import { createBrowserSyncTransport } from "../../shell/src/components/settings/sections/SyncBackupSection";

function snapshot(): DesktopSyncSnapshot {
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
    }],
    backup: null,
    backupState: "unknown",
  };
}

beforeEach(() => {
  window.operator = {
    invoke: vi.fn(async () => snapshot()),
    on: vi.fn(() => () => undefined),
  };
});

afterEach(() => cleanup());

describe("Sync & backup settings adapters", () => {
  it("routes Electron folder actions through the typed preload bridge", async () => {
    render(<SyncBackupSection />);

    expect(await screen.findByText("Documents")).toBeTruthy();
    expect(window.operator.invoke).toHaveBeenCalledWith("sync:get-snapshot", {});
    fireEvent.click(screen.getByRole("button", { name: "Rescan" }));
    await waitFor(() => expect(window.operator.invoke).toHaveBeenCalledWith("sync:rescan", {
      mappingId: "5a8ee913-b09a-4071-ac99-99436ca30946",
    }));
  });

  it("builds a read-only browser snapshot from the bounded backup-health endpoint", async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(String(url).endsWith("/status") ? {
      connectedPeers: [],
      manifestVersion: 5,
      fileCount: 12,
      totalSize: 4096,
      lastSyncAt: 1_800_000_000_000,
      pendingConflicts: 2,
      protocolVersion: 3,
      capabilities: {
        stagedUploads: true,
        immutableBlobs: true,
        immutableManifestGenerations: true,
      },
    } : {
      schemaVersion: 1,
      scheduler: { enabled: true, active: true, nextDueAt: null },
      lastAttempt: null,
      lastSuccess: null,
      storageReachability: "reachable",
      freshness: "unknown",
      observedAt: 1_800_000_000_000,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const transport = createBrowserSyncTransport({
      gatewayUrl: "https://matrix.example/vm/ada/~runtime/secondary",
      fetchFn,
      openDesktop: vi.fn(),
    });
    const result = await transport.getSnapshot();

    expect(fetchFn).toHaveBeenCalledWith(
      "https://matrix.example/vm/ada/~runtime/secondary/api/sync/backup-status",
      expect.objectContaining({ method: "GET", credentials: "same-origin" }),
    );
    expect(fetchFn).toHaveBeenCalledWith(
      "https://matrix.example/vm/ada/~runtime/secondary/api/sync/status",
      expect.objectContaining({ method: "GET", credentials: "same-origin" }),
    );
    expect(fetchFn.mock.calls.every((call) => call[1]?.signal instanceof AbortSignal)).toBe(true);
    expect(result).toMatchObject({
      capability: "unsupported_platform",
      service: "not_configured",
      status: "unavailable",
      backupState: "available",
      connection: "online",
      remoteStatus: expect.objectContaining({ fileCount: 12, pendingConflicts: 2 }),
    });
  });

  it("does not expose server error details when browser backup health is unavailable", async () => {
    const transport = createBrowserSyncTransport({
      gatewayUrl: "https://matrix.example",
      fetchFn: vi.fn(async () => new Response("private provider failure", { status: 503 })),
      openDesktop: vi.fn(),
    });

    await expect(transport.getSnapshot()).resolves.toMatchObject({
      backup: null,
      backupState: "unavailable",
      connection: "online",
      remoteStatus: null,
    });
  });
});

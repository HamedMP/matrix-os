const mockUseSettingsSyncBackup = jest.fn();

jest.mock("@/lib/queries/use-settings-sync-backup", () => ({
  useSettingsSyncBackup: () => mockUseSettingsSyncBackup(),
}));

import React from "react";
import { render, screen } from "@testing-library/react-native";

import SyncBackupSettingsScreen from "../app/settings-detail/sync-backup";

describe("native mobile Sync & backup settings", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseSettingsSyncBackup.mockReturnValue({
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
      syncStatus: {
        fileCount: 12,
        pendingConflicts: 3,
        lastSyncAt: 1_800_000_000_000,
      },
      isPending: false,
      isError: false,
    });
  });

  it("shows remote backup health without claiming native folder sync", () => {
    render(<SyncBackupSettingsScreen />);

    expect(screen.getByText("Requires Matrix Desktop")).toBeTruthy();
    expect(screen.getByText("Healthy")).toBeTruthy();
    expect(screen.getByText("12 files · 3 conflicts")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("Database recovery copies are separate from file sync.")).toBeTruthy();
  });

  it("keeps the platform limitation visible when backup health is unavailable", () => {
    mockUseSettingsSyncBackup.mockReturnValue({ backup: undefined, syncStatus: undefined, isPending: false, isError: true });

    render(<SyncBackupSettingsScreen />);

    expect(screen.getByText("Requires Matrix Desktop")).toBeTruthy();
    expect(screen.getByText("Backup health could not be loaded. Try again later.")).toBeTruthy();
  });
});

import { describe, expect, it } from "vitest";
import {
  applyShellRefreshFailure,
  applyShellRefreshSilentFailure,
  applyShellRefreshSuccess,
  applyShellUiStatePatch,
  rollbackShellUiStatePatch,
  type ShellRefreshState,
  type ShellSessionSummary,
} from "../../shell/src/components/terminal/terminal-session-state.js";

const mainShell: ShellSessionSummary = {
  name: "main",
  status: "active",
  placement: "active",
  latestSeq: 8,
  lastSeenSeq: 4,
  unread: true,
  visualStatus: "running",
  tabs: [],
};

describe("terminal session state helpers", () => {
  it("rolls back only optimistic fields that still match the failed patch", () => {
    const optimistic = applyShellUiStatePatch(mainShell, {
      placement: "background",
      lastSeenSeq: 8,
    });
    const concurrentlyRefreshed = {
      ...optimistic,
      placement: "background",
      latestSeq: 12,
      lastSeenSeq: 10,
      unread: true,
    };

    expect(rollbackShellUiStatePatch(
      concurrentlyRefreshed,
      { placement: "background", lastSeenSeq: 8 },
      { placement: "active", lastSeenSeq: 4 },
    )).toMatchObject({
      placement: "active",
      latestSeq: 12,
      lastSeenSeq: 10,
      unread: true,
    });
  });

  it("keeps last-known terminal sessions visible and stale after refresh failure", () => {
    const state: ShellRefreshState = {
      shells: [mainShell],
      authoritative: true,
      stale: false,
      error: null,
    };

    expect(applyShellRefreshFailure(state, "Failed to load shells")).toEqual({
      shells: [mainShell],
      authoritative: true,
      stale: true,
      error: "Failed to load shells",
    });
  });

  it("clears stale refresh state after a current authoritative session list loads", () => {
    const staleState: ShellRefreshState = {
      shells: [mainShell],
      authoritative: true,
      stale: true,
      error: "Failed to load shells",
    };
    const nextShell = { ...mainShell, name: "bench" };

    expect(applyShellRefreshSuccess(staleState, [nextShell], true)).toEqual({
      shells: [nextShell],
      authoritative: true,
      stale: false,
      error: null,
    });
  });

  it("marks silent refresh failures stale through the committed refresh state without surfacing an error", () => {
    const state: ShellRefreshState = {
      shells: [mainShell],
      authoritative: true,
      stale: false,
      error: null,
    };

    expect(applyShellRefreshSilentFailure(state)).toEqual({
      shells: [mainShell],
      authoritative: true,
      stale: true,
      error: null,
    });
  });
});

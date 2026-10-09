import React from "react";
import { Alert, AppState, type AlertButton, type AppStateStatus } from "react-native";
import { act, render } from "@testing-library/react-native";
import * as Updates from "expo-updates";
import { capture } from "../lib/analytics";
import { OtaUpdatePrompt } from "../components/OtaUpdatePrompt";
import { resetOtaUpdatePromptSession } from "../lib/use-ota-update-prompt";

const mockUpdatesModule = { isEnabled: true };
const mockUseUpdates = jest.fn();

// jest-expo's automock leaves the native state machine context untyped, so the
// real checkForUpdateAsync cannot run under it. Mock the JS surface instead.
jest.mock("expo-updates", () => ({
  __esModule: true,
  get isEnabled() {
    return mockUpdatesModule.isEnabled;
  },
  useUpdates: () => mockUseUpdates(),
  checkForUpdateAsync: jest.fn(),
  fetchUpdateAsync: jest.fn(),
  reloadAsync: jest.fn(),
  UpdateInfoType: { NEW: "new", ROLLBACK: "rollback" },
}));

jest.mock("../lib/analytics", () => ({ capture: jest.fn() }));

const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const checkForUpdate = Updates.checkForUpdateAsync as jest.Mock;
const fetchUpdate = Updates.fetchUpdateAsync as jest.Mock;
const reload = Updates.reloadAsync as jest.Mock;
const captured = capture as jest.Mock;
const removeAppStateListener = jest.fn();

let now = 0;
let appStateHandler: ((state: AppStateStatus) => void) | undefined;
let alert: jest.SpyInstance;
let warn: jest.SpyInstance;

function updatesState(overrides: Record<string, unknown> = {}) {
  return {
    currentlyRunning: {
      updateId: "running-update",
      isEmbeddedLaunch: false,
      isEmergencyLaunch: false,
      emergencyLaunchReason: null,
    },
    isStartupProcedureRunning: false,
    isUpdateAvailable: false,
    isUpdatePending: false,
    isChecking: false,
    isDownloading: false,
    isRestarting: false,
    restartCount: 0,
    ...overrides,
  };
}

function pendingUpdate(updateId: string) {
  return updatesState({
    isUpdatePending: true,
    downloadedUpdate: { type: "new", updateId, createdAt: new Date(1_700_000_000_000), manifest: {} },
  });
}

function codedError(code: string) {
  return Object.assign(new Error("native detail that must stay out of logs"), { code });
}

function alertButton(text: string, call = 0): AlertButton {
  const buttons = alert.mock.calls[call]?.[2] as AlertButton[] | undefined;
  const button = buttons?.find((candidate) => candidate.text === text);
  if (!button) throw new Error(`Alert ${call} has no "${text}" button`);
  return button;
}

const flushPromises = () => new Promise<void>((resolve) => setImmediate(resolve));

async function settle(action: () => void) {
  await act(async () => {
    action();
    await flushPromises();
  });
}

async function enterAppState(state: AppStateStatus) {
  await settle(() => appStateHandler?.(state));
}

beforeEach(() => {
  now = 1_000_000;
  jest.spyOn(Date, "now").mockImplementation(() => now);
  mockUpdatesModule.isEnabled = true;
  mockUseUpdates.mockReset().mockReturnValue(updatesState());
  checkForUpdate.mockReset().mockResolvedValue({ isAvailable: false, isRollBackToEmbedded: false });
  fetchUpdate.mockReset().mockResolvedValue({ isNew: true, isRollBackToEmbedded: false });
  reload.mockReset().mockResolvedValue(undefined);
  captured.mockReset();
  removeAppStateListener.mockReset();
  appStateHandler = undefined;
  jest.spyOn(AppState, "addEventListener").mockImplementation((_type, handler) => {
    appStateHandler = handler as (state: AppStateStatus) => void;
    return { remove: removeAppStateListener } as unknown as ReturnType<typeof AppState.addEventListener>;
  });
  alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  resetOtaUpdatePromptSession();
});

afterEach(() => jest.restoreAllMocks());

describe("OTA update prompt", () => {
  it("stays quiet while no update has been downloaded", () => {
    render(<OtaUpdatePrompt />);

    expect(alert).not.toHaveBeenCalled();
  });

  it("offers Update now or Later once an update has finished downloading", () => {
    mockUseUpdates.mockReturnValue(pendingUpdate("update-2"));

    render(<OtaUpdatePrompt />);

    expect(alert).toHaveBeenCalledTimes(1);
    const [title, message, buttons] = alert.mock.calls[0] as [string, string, AlertButton[]];
    expect(title).toBe("Update ready");
    expect(message).toBe(
      "A new version of Matrix OS is ready. Restart now to use it, or it’ll apply the next time you open the app.",
    );
    expect(buttons.map((button) => button.text)).toEqual(["Later", "Update now"]);
    expect(alertButton("Later").style).toBe("cancel");
    // The native launch check already downloaded it; JS must not fetch again.
    expect(fetchUpdate).not.toHaveBeenCalled();
    expect(captured).toHaveBeenCalledWith("mobile_ota_update_prompt_shown", { update_type: "new" });
  });

  it("restarts into the update when the user chooses Update now", async () => {
    mockUseUpdates.mockReturnValue(pendingUpdate("update-2"));
    render(<OtaUpdatePrompt />);

    await settle(() => alertButton("Update now").onPress?.());

    expect(reload).toHaveBeenCalledTimes(1);
    expect(captured).toHaveBeenCalledWith("mobile_ota_update_accepted", { update_type: "new" });
  });

  it("leaves the update for the next launch when the user chooses Later", async () => {
    mockUseUpdates.mockReturnValue(pendingUpdate("update-2"));
    render(<OtaUpdatePrompt />);

    await settle(() => alertButton("Later").onPress?.());

    expect(reload).not.toHaveBeenCalled();
    expect(captured).toHaveBeenCalledWith("mobile_ota_update_deferred", { update_type: "new" });
  });

  it("prompts only once for the same update, even after the shell remounts", () => {
    mockUseUpdates.mockReturnValue(pendingUpdate("update-2"));

    const first = render(<OtaUpdatePrompt />);
    first.rerender(<OtaUpdatePrompt />);
    first.unmount();
    render(<OtaUpdatePrompt />);

    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("prompts again when a newer update finishes downloading", () => {
    mockUseUpdates.mockReturnValue(pendingUpdate("update-2"));
    const view = render(<OtaUpdatePrompt />);

    mockUseUpdates.mockReturnValue(pendingUpdate("update-3"));
    view.rerender(<OtaUpdatePrompt />);

    expect(alert).toHaveBeenCalledTimes(2);
  });

  it("ignores a pending flag that carries no downloaded update", () => {
    // fetchUpdateAsync reports "pending" even when it found nothing new.
    mockUseUpdates.mockReturnValue(updatesState({ isUpdatePending: true }));

    render(<OtaUpdatePrompt />);

    expect(alert).not.toHaveBeenCalled();
  });

  it("prompts for a roll back to the embedded update", () => {
    mockUseUpdates.mockReturnValue(
      updatesState({
        isUpdatePending: true,
        downloadedUpdate: {
          type: "rollback",
          updateId: undefined,
          createdAt: new Date(1_700_000_000_000),
          manifest: undefined,
        },
      }),
    );

    const view = render(<OtaUpdatePrompt />);
    view.rerender(<OtaUpdatePrompt />);

    expect(alert).toHaveBeenCalledTimes(1);
    expect(captured).toHaveBeenCalledWith("mobile_ota_update_prompt_shown", { update_type: "rollback" });
  });

  it("does not prompt for the update that is already running", () => {
    mockUseUpdates.mockReturnValue(pendingUpdate("running-update"));

    render(<OtaUpdatePrompt />);

    expect(alert).not.toHaveBeenCalled();
  });

  it("tells the user when the restart fails and keeps the failure detail out of the log", async () => {
    mockUseUpdates.mockReturnValue(pendingUpdate("update-2"));
    reload.mockRejectedValue(codedError("ERR_UPDATES_RELOAD"));
    const view = render(<OtaUpdatePrompt />);

    await settle(() => {
      alertButton("Update now").onPress?.();
      alertButton("Update now").onPress?.();
    });
    view.rerender(<OtaUpdatePrompt />);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[mobile] OTA update restart failed", "ERR_UPDATES_RELOAD");
    expect(alert).toHaveBeenCalledTimes(2);
    expect(alert.mock.calls[1]).toEqual([
      "Couldn’t restart",
      "The update will apply the next time you open the app.",
    ]);
    expect(captured).toHaveBeenCalledWith("mobile_ota_update_reload_failed", { update_type: "new" });
  });

  it("never sends update identifiers to analytics", async () => {
    mockUseUpdates.mockReturnValue(pendingUpdate("update-2"));
    render(<OtaUpdatePrompt />);
    await settle(() => alertButton("Update now").onPress?.());

    expect(captured.mock.calls.length).toBeGreaterThan(0);
    for (const [, props] of captured.mock.calls as [string, Record<string, unknown>][]) {
      expect(Object.keys(props)).toEqual(["update_type"]);
    }
  });
});

describe("OTA foreground update check", () => {
  it("leaves the launch check to native and does not check again straight away", async () => {
    render(<OtaUpdatePrompt />);

    await enterAppState("active");

    expect(checkForUpdate).not.toHaveBeenCalled();
  });

  it("checks when the app returns to the foreground after the throttle window", async () => {
    render(<OtaUpdatePrompt />);
    now += CHECK_INTERVAL_MS;

    await enterAppState("active");

    expect(checkForUpdate).toHaveBeenCalledTimes(1);
    expect(fetchUpdate).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it.each([
    ["a new update", { isAvailable: true, isRollBackToEmbedded: false }],
    ["a roll back to the embedded update", { isAvailable: false, isRollBackToEmbedded: true }],
  ])("downloads %s found on foreground", async (_label, checkResult) => {
    checkForUpdate.mockResolvedValue(checkResult);
    render(<OtaUpdatePrompt />);
    now += CHECK_INTERVAL_MS;

    await enterAppState("active");

    expect(fetchUpdate).toHaveBeenCalledTimes(1);
  });

  it("throttles repeated foreground checks", async () => {
    render(<OtaUpdatePrompt />);
    now += CHECK_INTERVAL_MS;

    await enterAppState("active");
    now += CHECK_INTERVAL_MS - 1;
    await enterAppState("active");
    expect(checkForUpdate).toHaveBeenCalledTimes(1);

    now += 1;
    await enterAppState("active");
    expect(checkForUpdate).toHaveBeenCalledTimes(2);
  });

  it("runs one check at a time", async () => {
    let finishCheck: (result: unknown) => void = () => {};
    checkForUpdate.mockReturnValue(new Promise((resolve) => { finishCheck = resolve; }));
    render(<OtaUpdatePrompt />);
    now += CHECK_INTERVAL_MS;

    await enterAppState("active");
    now += CHECK_INTERVAL_MS;
    await enterAppState("active");

    expect(checkForUpdate).toHaveBeenCalledTimes(1);
    await settle(() => finishCheck({ isAvailable: false, isRollBackToEmbedded: false }));
  });

  it.each(["background", "inactive"] as const)("does not check when the app becomes %s", async (state) => {
    render(<OtaUpdatePrompt />);
    now += CHECK_INTERVAL_MS;

    await enterAppState(state);

    expect(checkForUpdate).not.toHaveBeenCalled();
  });

  it("does nothing when updates are disabled in this build", async () => {
    mockUpdatesModule.isEnabled = false;

    render(<OtaUpdatePrompt />);
    now += CHECK_INTERVAL_MS;
    await enterAppState("active");

    expect(appStateHandler).toBeUndefined();
    expect(checkForUpdate).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it("logs a failed check without prompting and retries after the window", async () => {
    checkForUpdate.mockRejectedValueOnce(codedError("ERR_UPDATES_CHECK"));
    render(<OtaUpdatePrompt />);
    now += CHECK_INTERVAL_MS;

    await enterAppState("active");

    expect(warn).toHaveBeenCalledWith("[mobile] OTA update check failed", "ERR_UPDATES_CHECK");
    expect(alert).not.toHaveBeenCalled();

    now += CHECK_INTERVAL_MS;
    await enterAppState("active");
    expect(checkForUpdate).toHaveBeenCalledTimes(2);
  });

  it.each(["ERR_NOT_AVAILABLE_IN_DEV_CLIENT", "ERR_UPDATES_DISABLED"])(
    "stops checking for the session after %s",
    async (code) => {
      checkForUpdate.mockRejectedValue(codedError(code));
      render(<OtaUpdatePrompt />);
      now += CHECK_INTERVAL_MS;

      await enterAppState("active");
      now += CHECK_INTERVAL_MS;
      await enterAppState("active");

      expect(checkForUpdate).toHaveBeenCalledTimes(1);
    },
  );

  it("logs a failed download without prompting", async () => {
    checkForUpdate.mockResolvedValue({ isAvailable: true, isRollBackToEmbedded: false });
    fetchUpdate.mockRejectedValue(codedError("ERR_UPDATES_FETCH"));
    render(<OtaUpdatePrompt />);
    now += CHECK_INTERVAL_MS;

    await enterAppState("active");

    expect(warn).toHaveBeenCalledWith("[mobile] OTA update check failed", "ERR_UPDATES_FETCH");
    expect(alert).not.toHaveBeenCalled();
  });

  it("falls back to the error name when a failure carries no code", async () => {
    checkForUpdate.mockRejectedValue(new TypeError("native detail that must stay out of logs"));
    render(<OtaUpdatePrompt />);
    now += CHECK_INTERVAL_MS;

    await enterAppState("active");

    expect(warn).toHaveBeenCalledWith("[mobile] OTA update check failed", "TypeError");
  });

  it("stops listening for app state changes when unmounted", () => {
    const view = render(<OtaUpdatePrompt />);

    view.unmount();

    expect(removeAppStateListener).toHaveBeenCalledTimes(1);
  });
});

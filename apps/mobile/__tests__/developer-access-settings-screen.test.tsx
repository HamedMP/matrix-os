const mockUseGateway = jest.fn();
const focusCleanups: Array<undefined | (() => void)> = [];
const focusEffects: Array<() => void | (() => void)> = [];
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn() }),
  useFocusEffect: (effect: () => void | (() => void)) => {
    const React = require("react");
    focusEffects[0] = effect;
    React.useEffect(() => {
      const cleanup = effect();
      focusCleanups.push(cleanup || undefined);
      return cleanup;
    }, [effect]);
  },
}));
jest.mock("@/app/_layout", () => ({ useGateway: () => mockUseGateway() }));
jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn().mockResolvedValue(true) }));
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import { Linking } from "react-native";
import * as Clipboard from "expo-clipboard";
import DeveloperAccessSettingsScreen from "../app/settings-detail/developer-access";

const readyStatus = {
  installed: true, authenticated: true, user: "octocat", gitProtocol: "ssh",
  sshStatus: "verified", commitIdentity: { status: "ready", label: "Octo Cat <octo@example.com>" },
  ready: true, errorCode: null,
};
const id = "bda87d44-cbe8-4bc0-b681-1e07ecfa3d47";
const waiting = { id, state: "awaiting_authorization", deviceCode: "ABCD-1234" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("GitHub developer access settings", () => {
  let client: Record<string, jest.Mock>;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    focusCleanups.length = 0;
    client = {
      getGithubDeveloperStatus: jest.fn().mockResolvedValue({ ok: true, status: { ...readyStatus, ready: false, authenticated: false, user: null } }),
      startGithubDeveloperSetup: jest.fn().mockResolvedValue(waiting),
      getGithubDeveloperSetup: jest.fn().mockResolvedValue(waiting),
      cancelGithubDeveloperSetup: jest.fn().mockResolvedValue({ id, state: "cancelled" }),
      createGithubDeveloperSetupSession: jest.fn(),
    };
    mockUseGateway.mockReturnValue({ client, gateway: { id: "computer-a" } });
    jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
  });
  afterEach(async () => { cleanup(); await act(async () => {}); jest.useRealTimers(); jest.restoreAllMocks(); });
  async function connect() {
    fireEvent.press(await screen.findByLabelText("Connect GitHub developer access"));
    await act(async () => {});
  }
  async function poll() { await act(async () => { jest.advanceTimersByTime(1000); }); }

  it("shows truthful readiness and allows explicit refresh", async () => {
    client.getGithubDeveloperStatus.mockResolvedValue({ ok: true, status: readyStatus });
    render(<DeveloperAccessSettingsScreen />);
    expect(await screen.findByText("octocat")).toBeTruthy();
    expect(screen.getByText("Verified")).toBeTruthy();
    expect(screen.getByText(readyStatus.commitIdentity.label)).toBeTruthy();
    expect(screen.getByText("Ready to clone, commit, push, and open pull requests.")).toBeTruthy();
    expect(screen.queryByLabelText("Connect GitHub developer access")).toBeNull();
    fireEvent.press(screen.getByLabelText("Refresh GitHub developer access"));
    await act(async () => {});
    expect(client.getGithubDeveloperStatus).toHaveBeenCalledTimes(2);
  });
  it("hides Connect until status is known", async () => {
    const status = deferred<unknown>();
    client.getGithubDeveloperStatus.mockReturnValue(status.promise);
    render(<DeveloperAccessSettingsScreen />);
    expect(screen.queryByLabelText("Connect GitHub developer access")).toBeNull();
    await act(async () => status.resolve({ ok: true, status: readyStatus }));
  });
  it.each([null, { ...readyStatus, installed: false, ready: false }])("offers update recovery instead of a broken setup for unavailable CLI/status", async (status) => {
    client.getGithubDeveloperStatus.mockResolvedValue(status ? { ok: true, status } : { ok: false });
    render(<DeveloperAccessSettingsScreen />);
    expect(await screen.findByText(/Update this Matrix computer/)).toBeTruthy();
    expect(screen.queryByLabelText("Connect GitHub developer access")).toBeNull();
  });
  it("shows Finish setup for a partially configured account", async () => {
    client.getGithubDeveloperStatus.mockResolvedValue({ ok: true, status: { ...readyStatus, ready: false, sshStatus: "setup_required" } });
    render(<DeveloperAccessSettingsScreen />);
    expect(await screen.findByLabelText("Finish GitHub developer access setup")).toBeTruthy();
  });
  it("starts once, shows a code, copies it and opens GitHub from Settings", async () => {
    const started = deferred<unknown>();
    client.startGithubDeveloperSetup.mockReturnValue(started.promise);
    render(<DeveloperAccessSettingsScreen />);
    const button = await screen.findByLabelText("Connect GitHub developer access");
    fireEvent.press(button); fireEvent.press(button);
    expect(client.startGithubDeveloperSetup).toHaveBeenCalledTimes(1);
    await act(async () => started.resolve(waiting));
    expect(screen.getByText("ABCD-1234")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Copy GitHub code"));
    await act(async () => {});
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith("ABCD-1234");
    expect(screen.getByText("Copied")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Open GitHub"));
    await act(async () => {});
    expect(Linking.openURL).toHaveBeenCalledWith("https://github.com/login/device");
    expect(client.createGithubDeveloperSetupSession).not.toHaveBeenCalled();
  });
  it("refreshes readiness automatically after setup succeeds", async () => {
    render(<DeveloperAccessSettingsScreen />); await connect();
    client.getGithubDeveloperSetup.mockResolvedValue({ id, state: "succeeded" });
    client.getGithubDeveloperStatus.mockResolvedValue({ ok: true, status: readyStatus });
    await poll();
    expect(screen.queryByText("ABCD-1234")).toBeNull();
    expect(screen.getByText("Ready to clone, commit, push, and open pull requests.")).toBeTruthy();
  });
  it.each(["expired", "failed", "cancelled"])("clears the code and permits retry after %s", async (state) => {
    render(<DeveloperAccessSettingsScreen />); await connect();
    client.getGithubDeveloperSetup.mockResolvedValue({ id, state });
    await poll();
    expect(screen.queryByText("ABCD-1234")).toBeNull();
    fireEvent.press(screen.getByLabelText("Try again")); await act(async () => {});
    expect(client.startGithubDeveloperSetup).toHaveBeenCalledTimes(2);
  });
  it("cancels the known operation and clears its code", async () => {
    render(<DeveloperAccessSettingsScreen />); await connect();
    fireEvent.press(screen.getByLabelText("Cancel GitHub setup")); await act(async () => {});
    expect(client.cancelGithubDeveloperSetup).toHaveBeenCalledWith(id);
    expect(screen.queryByText("ABCD-1234")).toBeNull();
  });
  it.each(["blur", "unmount", "switch"])("cancels late start results without showing codes after %s", async (action) => {
    const started = deferred<unknown>(); client.startGithubDeveloperSetup.mockReturnValue(started.promise);
    const view = render(<DeveloperAccessSettingsScreen />); await connect();
    const original = client;
    if (action === "blur") act(() => focusCleanups.forEach((cleanup) => cleanup?.()));
    if (action === "unmount") view.unmount();
    if (action === "switch") {
      client = { ...client, cancelGithubDeveloperSetup: jest.fn() };
      mockUseGateway.mockReturnValue({ client, gateway: { id: "computer-b" } });
      view.rerender(<DeveloperAccessSettingsScreen />);
    }
    await act(async () => started.resolve(waiting));
    expect(original.cancelGithubDeveloperSetup).toHaveBeenCalledWith(id);
    if (action !== "unmount") expect(screen.queryByText("ABCD-1234")).toBeNull();
    if (action === "switch") expect(client.cancelGithubDeveloperSetup).not.toHaveBeenCalled();
  });
  it("cancels a known operation after navigation and ignores a late poll", async () => {
    const polled = deferred<unknown>();
    client.getGithubDeveloperSetup.mockReturnValue(polled.promise);
    render(<DeveloperAccessSettingsScreen />); await connect(); await poll();
    act(() => focusCleanups.forEach((cleanup) => cleanup?.()));
    await act(async () => polled.resolve({ id, state: "succeeded" }));
    expect(client.cancelGithubDeveloperSetup).toHaveBeenCalledWith(id);
    expect(client.getGithubDeveloperStatus).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("ABCD-1234")).toBeNull();
  });
  it("expires and cancels a setup that exceeds the overall deadline", async () => {
    render(<DeveloperAccessSettingsScreen />); await connect();
    await act(async () => { jest.advanceTimersByTime(10 * 60_000); });
    expect(screen.getByText("This GitHub code expired. Start again to get a new code.")).toBeTruthy();
    expect(client.cancelGithubDeveloperSetup).toHaveBeenCalledWith(id);
    expect(screen.queryByText("ABCD-1234")).toBeNull();
  });
  it("retries transient polls then shows safe recovery and cancels", async () => {
    client.getGithubDeveloperSetup.mockRejectedValue(new Error("secret network error"));
    render(<DeveloperAccessSettingsScreen />); await connect();
    await poll(); await poll(); await poll();
    expect(client.getGithubDeveloperSetup).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Couldn't finish GitHub sign-in on this computer.")).toBeTruthy();
    expect(client.cancelGithubDeveloperSetup).toHaveBeenCalledWith(id);
    expect(screen.queryByText("secret network error")).toBeNull();
  });
  it("clears the one-time code while the computer finishes verification", async () => {
    render(<DeveloperAccessSettingsScreen />); await connect();
    client.getGithubDeveloperSetup.mockResolvedValue({ id, state: "starting" });
    await poll();
    expect(screen.queryByText("ABCD-1234")).toBeNull();
    expect(screen.getByText("Checking the connection…")).toBeTruthy();
  });
  it("handles copy and browser failures with safe, recoverable messages", async () => {
    (Clipboard.setStringAsync as jest.Mock).mockRejectedValueOnce(new Error("secret"));
    (Linking.openURL as jest.Mock).mockRejectedValueOnce(new Error("secret"));
    render(<DeveloperAccessSettingsScreen />); await connect();
    fireEvent.press(screen.getByLabelText("Copy GitHub code")); await act(async () => {});
    expect(screen.getByText("Couldn't copy the code. You can select and copy it.")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Open GitHub")); await act(async () => {});
    expect(screen.getByText("Couldn't open GitHub. Try again.")).toBeTruthy();
    expect(screen.queryByText("secret")).toBeNull();
  });
});

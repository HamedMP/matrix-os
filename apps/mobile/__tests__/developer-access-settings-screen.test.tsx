const mockPush = jest.fn();
const mockUseGateway = jest.fn();
const focusEffects: Array<() => void | (() => void)> = [];

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
  useFocusEffect: (effect: () => void | (() => void)) => {
    const React = require("react");
    focusEffects[0] = effect;
    React.useEffect(effect, [effect]);
  },
}));

jest.mock("@/app/_layout", () => ({
  useGateway: () => mockUseGateway(),
}));

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";

import DeveloperAccessSettingsScreen from "../app/settings-detail/developer-access";

const readyStatus = {
  installed: true,
  authenticated: true,
  user: "octocat",
  gitProtocol: "ssh",
  sshStatus: "verified",
  commitIdentity: {
    status: "ready",
    label: "Octo Cat <1+octocat@users.noreply.github.com>",
  },
  ready: true,
  errorCode: null,
} as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("GitHub developer access settings", () => {
  const getGithubDeveloperStatus = jest.fn();
  const createGithubDeveloperSetupSession = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    focusEffects.length = 0;
    getGithubDeveloperStatus.mockResolvedValue({ ok: true, status: readyStatus });
    createGithubDeveloperSetupSession.mockResolvedValue(
      `tws_${"a".repeat(32)}:tt_${"b".repeat(32)}`,
    );
    mockUseGateway.mockReturnValue({
      client: { getGithubDeveloperStatus, createGithubDeveloperSetupSession },
      gateway: { id: "selected-computer" },
    });
  });

  it("shows truthful account, SSH, commit identity, and overall readiness", async () => {
    render(<DeveloperAccessSettingsScreen />);

    expect(await screen.findByText("octocat")).toBeTruthy();
    expect(screen.getByText("SSH access")).toBeTruthy();
    expect(screen.getByText("Verified")).toBeTruthy();
    expect(screen.getByText("Octo Cat <1+octocat@users.noreply.github.com>")).toBeTruthy();
    expect(screen.getByText("Ready to clone, commit, push, and open pull requests.")).toBeTruthy();
    expect(screen.queryByLabelText("Connect GitHub developer access")).toBeNull();
    expect(screen.getByLabelText("Refresh GitHub developer access")).toBeTruthy();
  });

  it("fails closed with recovery copy when status is unavailable", async () => {
    getGithubDeveloperStatus.mockResolvedValue({
      ok: false,
      error: "GitHub developer access unavailable",
    });

    render(<DeveloperAccessSettingsScreen />);

    expect(await screen.findByText("Status unavailable")).toBeTruthy();
    expect(screen.getByText("Refresh the status or finish setup in Terminal.")).toBeTruthy();
    expect(screen.getByLabelText("Connect GitHub developer access")).toBeTruthy();
  });

  it("offers Finish setup for a partially configured account", async () => {
    getGithubDeveloperStatus.mockResolvedValue({
      ok: true,
      status: {
        ...readyStatus,
        sshStatus: "setup_required",
        commitIdentity: { status: "missing", label: null },
        ready: false,
      },
    });

    render(<DeveloperAccessSettingsScreen />);

    expect((await screen.findAllByText("Setup required")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByLabelText("Finish GitHub developer access setup")).toBeTruthy();
  });

  it("launches one fixed setup session and navigates only after a valid TerminalRef", async () => {
    const created = deferred<string | null>();
    createGithubDeveloperSetupSession.mockReturnValue(created.promise);
    getGithubDeveloperStatus.mockResolvedValue({
      ok: true,
      status: { ...readyStatus, authenticated: false, user: null, ready: false },
    });
    render(<DeveloperAccessSettingsScreen />);
    const connect = await screen.findByLabelText("Connect GitHub developer access");

    fireEvent.press(connect);
    fireEvent.press(connect);
    expect(createGithubDeveloperSetupSession).toHaveBeenCalledTimes(1);
    expect(createGithubDeveloperSetupSession).toHaveBeenCalledWith();
    expect(mockPush).not.toHaveBeenCalled();

    const terminalRef = `tws_${"a".repeat(32)}:tt_${"b".repeat(32)}`;
    await act(async () => created.resolve(terminalRef));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/terminal-session/[session]",
      params: { session: terminalRef },
    });
  });

  it("keeps recovery available and does not navigate for an invalid TerminalRef", async () => {
    createGithubDeveloperSetupSession.mockResolvedValue("not-a-terminal-ref");
    getGithubDeveloperStatus.mockResolvedValue({
      ok: true,
      status: { ...readyStatus, authenticated: false, user: null, ready: false },
    });
    render(<DeveloperAccessSettingsScreen />);

    fireEvent.press(await screen.findByLabelText("Connect GitHub developer access"));

    expect(await screen.findByText("Could not open the setup terminal. Try again.")).toBeTruthy();
    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Connect GitHub developer access")).toBeTruthy();
  });

  it("refreshes the selected computer status when the page regains focus", async () => {
    render(<DeveloperAccessSettingsScreen />);
    await waitFor(() => expect(getGithubDeveloperStatus).toHaveBeenCalledTimes(1));

    await act(async () => {
      focusEffects[0]?.();
    });

    expect(getGithubDeveloperStatus).toHaveBeenCalledTimes(2);
  });

  it("refreshes on demand", async () => {
    render(<DeveloperAccessSettingsScreen />);
    await waitFor(() => expect(getGithubDeveloperStatus).toHaveBeenCalledTimes(1));

    fireEvent.press(screen.getByLabelText("Refresh GitHub developer access"));

    await waitFor(() => expect(getGithubDeveloperStatus).toHaveBeenCalledTimes(2));
  });
});

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GITHUB_DEVELOPER_SERVICE_ID,
  GithubDeveloperAccess,
  githubDeveloperDisconnectCommand,
  withGithubDeveloperCatalogEntry,
  parseGithubDeveloperAccessStatus,
  type GithubDeveloperAccessClient,
} from "../../packages/ui/src/integrations/GithubDeveloperAccess.js";

import { IntegrationMarketplace } from "../../packages/ui/src/integrations/IntegrationMarketplace.js";

const readyStatus = {
  installed: true,
  authenticated: true,
  user: "octocat",
  gitProtocol: "ssh",
  sshStatus: "verified",
  commitIdentity: {
    status: "ready",
    label: "The Octocat <octocat@users.noreply.github.com>",
  },
  ready: true,
  errorCode: null,
};

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("GitHub developer access compatibility parser", () => {
  it("accepts the additive readiness contract and bounds user-visible labels", () => {
    expect(parseGithubDeveloperAccessStatus(readyStatus)).toEqual(readyStatus);
    expect(parseGithubDeveloperAccessStatus({
      ...readyStatus,
      user: "x".repeat(129),
      commitIdentity: { status: "ready", label: "x".repeat(526) },
    })).toMatchObject({
      user: null,
      commitIdentity: { status: "unavailable", label: null },
      ready: false,
    });
  });

  it("preserves a valid owner identity label longer than 256 characters", () => {
    const label = `${"a".repeat(180)} <${"b".repeat(90)}@example.com>`;
    expect(parseGithubDeveloperAccessStatus({
      ...readyStatus,
      commitIdentity: { status: "ready", label },
    })).toMatchObject({ commitIdentity: { status: "ready", label }, ready: true });
  });

  it("fails an older or malformed gateway response closed", () => {
    expect(parseGithubDeveloperAccessStatus({
      installed: true,
      authenticated: true,
      user: "octocat",
    })).toMatchObject({
      authenticated: true,
      sshStatus: "unavailable",
      commitIdentity: { status: "unavailable", label: null },
      ready: false,
    });
    expect(parseGithubDeveloperAccessStatus("/home/alice/.ssh/id_ed25519")).toBeNull();
  });
});

const writable = { mode: "writable" } as const;
const partialStatus = { ...readyStatus, ready: false, sshStatus: "setup_required" };
const finishSetup = "Finish setup GitHub Developer";
const setupId = "016d31b0-50d7-4dca-ae0d-b6083bdcd219";
const unusedSetupMethods = { getSetup: vi.fn(), cancelSetup: vi.fn(), openSetupPage: vi.fn() };

function GithubDeveloperAccessCard(props: { identityKey: string; client: GithubDeveloperAccessClient; active?: boolean }) {
  return (
    <GithubDeveloperAccess {...props}>
      {presentation => (
        <IntegrationMarketplace services={withGithubDeveloperCatalogEntry([])}
          connectedIds={presentation.ready ? [GITHUB_DEVELOPER_SERVICE_ID] : []}
          rowPresentation={() => presentation} onConnect={() => {}} />
      )}
    </GithubDeveloperAccess>
  );
}

function developerRow() {
  return within(screen.getByTestId("integration-card-github-developer"));
}


describe("GitHub Developer card", () => {
  it("opens a device sign-in dialog and refreshes canonical readiness after authorization", async () => {
    const client = {
      status: vi.fn().mockResolvedValueOnce(partialStatus).mockResolvedValueOnce(readyStatus),
      setupAccess: vi.fn().mockResolvedValue(writable),
      startSetup: vi.fn().mockResolvedValue({ id: setupId, state: "awaiting_authorization", deviceCode: "ABCD-EFGH" }),
      getSetup: vi.fn().mockResolvedValueOnce({ id: setupId, state: "starting" })
        .mockResolvedValueOnce({ id: setupId, state: "succeeded" }),
      cancelSetup: vi.fn(),
      openSetupPage: vi.fn(),
    };
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      render(<GithubDeveloperAccessCard identityKey="alice:primary" client={client} />);
      const setup = await screen.findByRole("button", { name: finishSetup });
      await waitFor(() => expect(setup).toBeEnabled());
      fireEvent.click(setup);
      const dialog = within(await screen.findByRole("dialog", { name: "Connect GitHub Developer" }));
      expect(await dialog.findByText("ABCD-EFGH")).toBeVisible();
      await act(async () => { fireEvent.click(dialog.getByRole("button", { name: "Copy" })); });
      expect(writeText).toHaveBeenCalledExactlyOnceWith("ABCD-EFGH");
      await act(async () => { fireEvent.click(dialog.getByRole("button", { name: "Open GitHub" })); });
      expect(client.openSetupPage).toHaveBeenCalledTimes(1);
      expect(await dialog.findByText("Checking the connection…", {}, { timeout: 3_000 })).toBeVisible();
      expect(screen.queryByText("ABCD-EFGH")).toBeNull();
      expect(await screen.findByText("Ready", {}, { timeout: 3_000 })).toBeVisible();
      expect(client.getSetup).toHaveBeenCalledTimes(2);
      expect(client.getSetup).toHaveBeenLastCalledWith(setupId, expect.any(AbortSignal));
      expect(client.status).toHaveBeenCalledTimes(2);
      expect(screen.queryByText("ABCD-EFGH")).toBeNull();
      expect(client.cancelSetup).not.toHaveBeenCalled();
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("cleans up a setup created while its start response was still pending at dismissal", async () => {
    let finishStart!: (value: unknown) => void;
    const client = {
      ...unusedSetupMethods,
      status: vi.fn().mockResolvedValue(partialStatus),
      setupAccess: vi.fn().mockResolvedValue(writable),
      startSetup: vi.fn((signal: AbortSignal) => new Promise((resolve, reject) => {
        finishStart = resolve;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })),
      cancelSetup: vi.fn(),
    };
    render(<GithubDeveloperAccessCard identityKey="alice:primary" client={client} />);
    const setup = await screen.findByRole("button", { name: finishSetup });
    await waitFor(() => expect(setup).toBeEnabled());
    fireEvent.click(setup);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    await act(async () => { finishStart({ id: setupId, state: "awaiting_authorization", deviceCode: "ABCD-EFGH" }); });
    expect(client.cancelSetup).toHaveBeenCalledExactlyOnceWith(setupId, expect.any(AbortSignal));
    expect(client.getSetup).not.toHaveBeenCalled();
    expect(screen.queryByText("ABCD-EFGH")).toBeNull();
    expect(setup).toBeEnabled();
  });

  it("cancels on dismissal and ignores a late response when the selected computer changes", async () => {
    let finishPoll!: (value: unknown) => void;
    const client = {
      ...unusedSetupMethods,
      status: vi.fn().mockResolvedValue(partialStatus),
      setupAccess: vi.fn().mockResolvedValue(writable),
      startSetup: vi.fn().mockResolvedValue({ id: setupId, state: "awaiting_authorization", deviceCode: "ABCD-EFGH" }),
      getSetup: vi.fn((_id: string, _signal: AbortSignal) => new Promise(resolve => { finishPoll = resolve; })),
      cancelSetup: vi.fn(),
    };
    const other = { ...client, startSetup: vi.fn(), status: vi.fn().mockResolvedValue(partialStatus), cancelSetup: vi.fn() };
    const view = render(<GithubDeveloperAccessCard identityKey="alice:primary" client={client} />);
    const setup = await screen.findByRole("button", { name: finishSetup });
    await waitFor(() => expect(setup).toBeEnabled());
    fireEvent.click(setup);
    expect(await screen.findByText("ABCD-EFGH")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("ABCD-EFGH")).toBeNull();
    await waitFor(() => expect(client.cancelSetup).toHaveBeenCalledExactlyOnceWith(setupId, expect.any(AbortSignal)));
    await waitFor(() => expect(setup).toBeEnabled());
    fireEvent.click(setup);
    await waitFor(() => expect(client.getSetup).toHaveBeenCalledTimes(1), { timeout: 3_000 });
    const signal = client.getSetup.mock.calls[0]?.[1];
    view.rerender(<GithubDeveloperAccessCard identityKey="alice:studio" client={other} />);
    expect(signal?.aborted).toBe(true);
    await act(async () => { finishPoll({ id: setupId, state: "succeeded" }); });
    expect(screen.queryByText("ABCD-EFGH")).toBeNull();
    expect(client.status).toHaveBeenCalledTimes(1);
    expect(other.cancelSetup).not.toHaveBeenCalled();
    expect(screen.queryByText("Ready")).toBeNull();
  });

  it("clears an expired code and allows a new attempt", async () => {
    const client = {
      ...unusedSetupMethods,
      status: vi.fn().mockResolvedValue(partialStatus),
      setupAccess: vi.fn().mockResolvedValue(writable),
      startSetup: vi.fn()
        .mockResolvedValueOnce({ id: setupId, state: "awaiting_authorization", deviceCode: "ABCD-EFGH" })
        .mockResolvedValueOnce({ id: "322046b5-ae42-4b8c-9875-6d68bba5ca93", state: "awaiting_authorization", deviceCode: "IJKL-MNOP" }),
      getSetup: vi.fn().mockResolvedValue({ id: setupId, state: "expired" }),
      cancelSetup: vi.fn(),
    };
    render(<GithubDeveloperAccessCard identityKey="alice:primary" client={client} />);
    const setup = await screen.findByRole("button", { name: finishSetup });
    await waitFor(() => expect(setup).toBeEnabled());
    fireEvent.click(setup);
    expect(await screen.findByText("ABCD-EFGH")).toBeVisible();
    expect(await screen.findByText(/This GitHub code expired/, {}, { timeout: 3_000 })).toBeVisible();
    expect(screen.queryByText("ABCD-EFGH")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open GitHub" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("IJKL-MNOP")).toBeVisible();
  });

  it.each(["remote_policy", "insufficient_permission", "runtime_unavailable"] as const)("keeps setup disabled for %s", async (reason) => {
    const startSetup = vi.fn();
    const client: GithubDeveloperAccessClient = {
      ...unusedSetupMethods,
      status: vi.fn().mockResolvedValue(partialStatus),
      setupAccess: vi.fn().mockResolvedValue({ mode: "read_only", reason }),
      startSetup,
      startDisconnect: vi.fn(),
    };
    render(<GithubDeveloperAccessCard identityKey="alice:primary" client={client} />);

    const setup = await screen.findByRole("button", { name: finishSetup });
    expect(setup).toBeDisabled();
    expect(await screen.findByText("Setup requires permission on this computer.")).toBeVisible();
    fireEvent.click(setup);
    expect(startSetup).not.toHaveBeenCalled();
    expect(developerRow().getAllByRole("button")).toHaveLength(1);
  });

  it("disconnects only after confirmation and shows Connect after a fresh signed-out status", async () => {
    const client: GithubDeveloperAccessClient = {
      ...unusedSetupMethods,
      status: vi.fn().mockResolvedValueOnce(readyStatus).mockResolvedValueOnce({
        ...readyStatus, authenticated: false, user: null, ready: false,
      }),
      setupAccess: vi.fn().mockResolvedValue(writable),
      startSetup: vi.fn(),
      startDisconnect: vi.fn().mockResolvedValue(true),
    };
    const view = render(<GithubDeveloperAccessCard identityKey="alice:primary" client={client} />);

    expect(await screen.findByText("Ready")).toBeVisible();
    const disconnect = await screen.findByRole("button", { name: "Disconnect GitHub Developer" });
    const identity = screen.getByText("octocat · SSH verified · The Octocat <octocat@users.noreply.github.com>");
    expect(identity).toBeVisible();
    expect(identity.parentElement).toBe(disconnect.parentElement);
    expect(disconnect.className).toContain("border-border/60");
    expect(disconnect.className).not.toContain("rounded-full");
    await waitFor(() => expect(disconnect).toBeEnabled());
    fireEvent.click(disconnect);
    let dialog = within(screen.getByRole("dialog", { name: "Disconnect GitHub Developer?" }));
    expect(dialog.getByText(/SSH keys and Git commit identity/)).toBeVisible();
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    expect(client.startDisconnect).not.toHaveBeenCalled();
    fireEvent.click(disconnect);
    dialog = within(screen.getByRole("dialog", { name: "Disconnect GitHub Developer?" }));
    await act(async () => { fireEvent.click(dialog.getByRole("button", { name: "Disconnect" })); });
    expect(client.startDisconnect).toHaveBeenCalledExactlyOnceWith("octocat", expect.any(AbortSignal));
    expect(client.startSetup).not.toHaveBeenCalled();
    expect(screen.getByText("Ready")).toBeVisible();

    view.rerender(<GithubDeveloperAccessCard identityKey="alice:primary" client={client} active={false} />);
    view.rerender(<GithubDeveloperAccessCard identityKey="alice:primary" client={client} active />);
    expect(await screen.findByRole("button", { name: "Connect GitHub Developer" })).toBeVisible();
    expect(screen.queryByText("Ready")).toBeNull();
  });

  it("never offers disconnect on a ready computer without writable owner settings", async () => {
    const client: GithubDeveloperAccessClient = {
      ...unusedSetupMethods,
      status: vi.fn().mockResolvedValue(readyStatus),
      setupAccess: vi.fn().mockResolvedValue({ mode: "read_only", reason: "runtime_unavailable" }),
      startSetup: vi.fn(),
      startDisconnect: vi.fn(),
    };
    render(<GithubDeveloperAccessCard identityKey="alice:primary" client={client} />);
    expect(await screen.findByText("Ready")).toBeVisible();
    await waitFor(() => expect(client.setupAccess).toHaveBeenCalledTimes(1));
    expect(developerRow().queryByRole("button")).toBeNull();
    expect(client.startDisconnect).not.toHaveBeenCalled();
  });

  it("abandons an open disconnect confirmation when the computer changes", async () => {
    const alice: GithubDeveloperAccessClient = {
      ...unusedSetupMethods,
      status: vi.fn().mockResolvedValue(readyStatus),
      setupAccess: vi.fn().mockResolvedValue(writable),
      startSetup: vi.fn(),
      startDisconnect: vi.fn(),
    };
    const bob: GithubDeveloperAccessClient = {
      ...alice, status: vi.fn().mockResolvedValue({ ...readyStatus, user: "hubot" }),
      startDisconnect: vi.fn(),
    };
    const view = render(<GithubDeveloperAccessCard identityKey="alice:primary" client={alice} />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect GitHub Developer" }));
    expect(screen.getByRole("dialog", { name: "Disconnect GitHub Developer?" })).toBeVisible();
    view.rerender(<GithubDeveloperAccessCard identityKey="bob:primary" client={bob} />);
    expect(screen.queryByRole("dialog", { name: "Disconnect GitHub Developer?" })).toBeNull();
    expect(alice.startDisconnect).not.toHaveBeenCalled();
    expect(bob.startDisconnect).not.toHaveBeenCalled();
  });

  it("rechecks owner permission at confirmation before dispatching disconnect", async () => {
    const client: GithubDeveloperAccessClient = {
      ...unusedSetupMethods,
      status: vi.fn().mockResolvedValue(readyStatus),
      setupAccess: vi.fn().mockResolvedValueOnce(writable)
        .mockResolvedValueOnce({ mode: "read_only", reason: "insufficient_permission" }),
      startSetup: vi.fn(),
      startDisconnect: vi.fn(),
    };
    render(<GithubDeveloperAccessCard identityKey="alice:primary" client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect GitHub Developer" }));
    const dialog = within(screen.getByRole("dialog", { name: "Disconnect GitHub Developer?" }));
    await act(async () => { fireEvent.click(dialog.getByRole("button", { name: "Disconnect" })); });
    expect(client.startDisconnect).not.toHaveBeenCalled();
    expect(developerRow().queryByRole("button")).toBeNull();
    expect(screen.getByText("Ready")).toBeVisible();
  });

  it("separates the selected account from the fixed, isolated terminal script", () => {
    const octocat = githubDeveloperDisconnectCommand("octocat");
    const hubot = githubDeveloperDisconnectCommand("hubot");
    expect(octocat?.slice(0, 4)).toEqual(hubot?.slice(0, 4));
    expect(octocat?.at(-1)).toBe("octocat");
    expect(octocat?.[2]).toContain('/usr/bin/env -i HOME="$owner_home"');
    expect(octocat?.[2]).toContain('GH_CONFIG_DIR="$owner_home/.config/gh"');
    expect(octocat?.[2]).toContain('auth logout --hostname github.com --user "$1"');
    expect(githubDeveloperDisconnectCommand("--all")).toBeNull();
  });

  it("locks setup while an attempt starts and offers a retry after failure", async () => {
    let releaseSetup!: (opened: boolean) => void;
    const startSetup = vi.fn(() => new Promise<boolean>((resolve) => { releaseSetup = resolve; }));
    const client = {
      ...unusedSetupMethods,
      status: vi.fn().mockResolvedValue(partialStatus),
      setupAccess: vi.fn().mockResolvedValue(writable),
      startSetup,
      startDisconnect: vi.fn(),
    };
    render(<GithubDeveloperAccessCard identityKey="alice:primary" client={client} />);

    const finish = await screen.findByRole("button", { name: finishSetup });
    await waitFor(() => expect(finish).toBeEnabled());
    fireEvent.click(finish);
    expect(finish).toBeDisabled();
    fireEvent.click(finish);
    expect(startSetup).toHaveBeenCalledTimes(1);

    await act(async () => { releaseSetup(false); });
    expect(screen.getByText("Couldn't finish GitHub sign-in on this computer.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("refreshes when the same settings panel becomes active after manual setup", async () => {
    const client = {
      ...unusedSetupMethods,
      status: vi.fn().mockResolvedValueOnce(partialStatus).mockResolvedValueOnce(readyStatus),
      setupAccess: vi.fn().mockResolvedValue(writable),
      startSetup: vi.fn(),
      startDisconnect: vi.fn(),
    };
    const view = render(<GithubDeveloperAccessCard identityKey="alice:primary" client={client} />);
    const finish = await screen.findByRole("button", { name: finishSetup });
    await waitFor(() => expect(finish).toBeEnabled());
    view.rerender(<GithubDeveloperAccessCard identityKey="alice:primary" client={client} active={false} />);
    fireEvent.focus(window);
    expect(client.status).toHaveBeenCalledTimes(1);

    view.rerender(<GithubDeveloperAccessCard identityKey="alice:primary" client={client} active />);
    expect(await screen.findByText("Ready")).toBeVisible();
    expect(client.status).toHaveBeenCalledTimes(2);
  });

  it("ignores a late status response after the owner/runtime identity changes", async () => {
    let releaseAlice!: (value: unknown) => void;
    let releaseBob!: (value: unknown) => void;
    const alice: GithubDeveloperAccessClient = {
      ...unusedSetupMethods,
      status: vi.fn(() => new Promise((resolve) => { releaseAlice = resolve; })),
      setupAccess: vi.fn().mockResolvedValue(writable),
      startSetup: vi.fn(),
      startDisconnect: vi.fn(),
    };
    const bob: GithubDeveloperAccessClient = {
      ...unusedSetupMethods,
      status: vi.fn(() => new Promise((resolve) => { releaseBob = resolve; })),
      setupAccess: vi.fn().mockResolvedValue(writable),
      startSetup: vi.fn(),
      startDisconnect: vi.fn(),
    };
    const view = render(<GithubDeveloperAccessCard identityKey="alice:primary" client={alice} />);
    view.rerender(<GithubDeveloperAccessCard identityKey="bob:primary" client={bob} />);
    expect(screen.getByText("Checking developer access…")).toBeVisible();

    await act(async () => {
      releaseAlice(readyStatus);
      releaseBob({ ...readyStatus, user: "hubot" });
    });
    expect(screen.getByText(/hubot · SSH verified/)).toBeVisible();
    expect(screen.queryByText(/octocat · SSH verified/)).toBeNull();
  });

  it("offers only a status retry after a failed read and hides error details", async () => {
    const client: GithubDeveloperAccessClient = {
      ...unusedSetupMethods,
      status: vi.fn().mockRejectedValueOnce(new Error("token leaked from /home/alice/.config/gh/hosts.yml"))
        .mockResolvedValueOnce(readyStatus),
      setupAccess: vi.fn().mockResolvedValue(writable),
      startSetup: vi.fn(),
      startDisconnect: vi.fn(),
    };
    render(<GithubDeveloperAccessCard identityKey="alice:primary" client={client} />);

    expect(await screen.findByText("GitHub developer access is unavailable.")).toBeVisible();
    expect(screen.queryByText(/token leaked|hosts\.yml/i)).toBeNull();
    expect(developerRow().getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry GitHub Developer status" }));
    expect(await screen.findByText("Ready")).toBeVisible();
    expect(client.startSetup).not.toHaveBeenCalled();
  });
});

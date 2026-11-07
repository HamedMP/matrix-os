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
  it.each(["remote_policy", "insufficient_permission"] as const)("keeps setup disabled for %s", async (reason) => {
    const startSetup = vi.fn();
    const client: GithubDeveloperAccessClient = {
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

  it("allows owner GitHub setup when only provider mutations are unavailable", async () => {
    const startSetup = vi.fn().mockResolvedValue(true);
    const client: GithubDeveloperAccessClient = {
      status: vi.fn().mockResolvedValue(partialStatus),
      setupAccess: vi.fn().mockResolvedValue({ mode: "read_only", reason: "runtime_unavailable" }),
      startSetup,
      startDisconnect: vi.fn(),
    };
    render(<GithubDeveloperAccessCard identityKey="alice:primary" client={client} />);

    const setup = await screen.findByRole("button", { name: finishSetup });
    await waitFor(() => expect(setup).toBeEnabled());
    await act(async () => { fireEvent.click(setup); });
    expect(startSetup).toHaveBeenCalledTimes(1);
  });

  it("disconnects only after confirmation and shows Connect after a fresh signed-out status", async () => {
    const client: GithubDeveloperAccessClient = {
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

  it("locks setup while a terminal handoff is pending and reports a retry after failure", async () => {
    let releaseSetup!: (opened: boolean) => void;
    const startSetup = vi.fn(() => new Promise<boolean>((resolve) => { releaseSetup = resolve; }));
    const client = {
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
    expect(screen.getByText("Could not open setup in Terminal.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry GitHub Developer setup" })).toBeEnabled();
  });

  it("refreshes when the same settings panel becomes active after Terminal setup", async () => {
    const client = {
      status: vi.fn().mockResolvedValueOnce(partialStatus).mockResolvedValueOnce(readyStatus),
      setupAccess: vi.fn().mockResolvedValue(writable),
      startSetup: vi.fn().mockResolvedValue(true),
      startDisconnect: vi.fn(),
    };
    const view = render(<GithubDeveloperAccessCard identityKey="alice:primary" client={client} />);
    const finish = await screen.findByRole("button", { name: finishSetup });
    await waitFor(() => expect(finish).toBeEnabled());
    await act(async () => { fireEvent.click(finish); });
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
      status: vi.fn(() => new Promise((resolve) => { releaseAlice = resolve; })),
      setupAccess: vi.fn().mockResolvedValue(writable),
      startSetup: vi.fn(),
      startDisconnect: vi.fn(),
    };
    const bob: GithubDeveloperAccessClient = {
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

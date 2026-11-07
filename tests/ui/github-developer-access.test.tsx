// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { AgentsProvidersView } from "../../packages/ui/src/agents-providers/AgentsProvidersView.js";
import {
  GithubDeveloperAccessCard,
  parseGithubDeveloperAccessStatus,
  type GithubDeveloperAccessClient,
} from "../../packages/ui/src/agents-providers/GithubDeveloperAccessCard.js";

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

describe("GitHub developer access card", () => {
  it.each([
    { state: "partial", reason: "remote_policy" as const },
    { state: "unavailable", reason: "insufficient_permission" as const },
  ])("keeps GitHub setup disabled for $reason when status is $state", async ({ state, reason }) => {
    const snapshot: ProviderSettingsSnapshot = {
      contractVersion: 1,
      projectionOf: { contract: "AiProviderSnapshotV3", contractVersion: 3, revision: 1 },
      revision: 1,
      refreshedAt: "2026-11-06T00:00:00Z",
      access: { mode: "read_only", reason },
      supportedActions: [], harnessCatalog: [], modelProviders: [],
      accessSources: [], accounts: [], harnesses: [], gatewayPolicy: null,
    };
    const startSetup = vi.fn().mockResolvedValue(true);
    const client: GithubDeveloperAccessClient = {
      status: state === "partial"
        ? vi.fn().mockResolvedValue({ ...readyStatus, ready: false, sshStatus: "setup_required" })
        : vi.fn().mockRejectedValue(new Error("unavailable")),
      startSetup,
    };
    render(<AgentsProvidersView snapshot={snapshot} selectedHarnessId={null}
      onSelectHarness={vi.fn()} onRefresh={vi.fn()} onMutate={vi.fn()}
      onOpenTerminal={vi.fn()} onOpenBrowser={vi.fn()} onAddCredit={vi.fn()}
      githubDeveloperAccess={{ identityKey: "alice:primary", client }} />);

    const setup = await screen.findByRole("button", { name: state === "partial" ? "Finish setup" : "Connect", exact: true });
    expect(setup).toBeDisabled();
    fireEvent.click(setup);
    expect(startSetup).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Refresh GitHub developer access" })).toBeEnabled();
  });

  it("allows owner GitHub setup when only provider mutations are unavailable", async () => {
    const snapshot: ProviderSettingsSnapshot = {
      contractVersion: 1,
      projectionOf: { contract: "AiProviderSnapshotV3", contractVersion: 3, revision: 1 },
      revision: 1,
      refreshedAt: "2026-11-06T00:00:00Z",
      access: { mode: "read_only", reason: "runtime_unavailable" },
      supportedActions: [], harnessCatalog: [], modelProviders: [],
      accessSources: [], accounts: [], harnesses: [], gatewayPolicy: null,
    };
    const startSetup = vi.fn().mockResolvedValue(true);
    const client: GithubDeveloperAccessClient = {
      status: vi.fn().mockResolvedValue({ ...readyStatus, ready: false, sshStatus: "setup_required" }),
      startSetup,
    };
    render(<AgentsProvidersView snapshot={snapshot} selectedHarnessId={null}
      onSelectHarness={vi.fn()} onRefresh={vi.fn()} onMutate={vi.fn()}
      onOpenTerminal={vi.fn()} onOpenBrowser={vi.fn()} onAddCredit={vi.fn()}
      githubDeveloperAccess={{ identityKey: "alice:primary", client }} />);

    const setup = await screen.findByRole("button", { name: "Finish setup", exact: true });
    expect(setup).toBeEnabled();
    await act(async () => { fireEvent.click(setup); });
    expect(startSetup).toHaveBeenCalledTimes(1);
  });

  it("shows account, SSH, and commit identity readiness outside the AI provider inventory", async () => {
    const client: GithubDeveloperAccessClient = {
      status: vi.fn().mockResolvedValue(readyStatus),
      startSetup: vi.fn(),
    };
    render(<GithubDeveloperAccessCard identityKey="alice:primary" client={client} />);

    expect(await screen.findByRole("heading", { name: "GitHub developer access" })).toBeVisible();
    expect(screen.getByText("octocat")).toBeVisible();
    expect(screen.getByText("SSH verified")).toBeVisible();
    expect(screen.getByText("The Octocat <octocat@users.noreply.github.com>")).toBeVisible();
    expect(screen.getByText("Ready for private repositories")).toBeVisible();
    expect(screen.queryByText(/AI provider/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /connect|finish setup/i })).toBeNull();
  });

  it("offers the fixed setup handoff and a separate refresh for partial setup", async () => {
    const startSetup = vi.fn().mockResolvedValue(undefined);
    const status = vi.fn().mockResolvedValue({
      ...readyStatus,
      sshStatus: "setup_required",
      ready: false,
    });
    render(<GithubDeveloperAccessCard identityKey="alice:primary" client={{ status, startSetup }} />);

    const finish = await screen.findByRole("button", { name: "Finish setup" });
    await act(async () => { fireEvent.click(finish); });
    expect(startSetup).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh GitHub developer access" }));
    });
    expect(status).toHaveBeenCalledTimes(2);
  });

  it("keeps setup locked while refresh completes during a pending terminal handoff", async () => {
    let releaseSetup!: (opened: boolean) => void;
    const startSetup = vi.fn(() => new Promise<boolean>((resolve) => { releaseSetup = resolve; }));
    const status = vi.fn().mockResolvedValue({
      ...readyStatus,
      sshStatus: "setup_required",
      ready: false,
    });
    render(<GithubDeveloperAccessCard identityKey="alice:primary" client={{ status, startSetup }} />);

    const finish = await screen.findByRole("button", { name: "Finish setup" });
    fireEvent.click(finish);
    expect(finish).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Refresh GitHub developer access" }));
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
    const refreshedFinish = await screen.findByRole("button", { name: "Finish setup" });
    expect(refreshedFinish).toBeDisabled();
    fireEvent.click(refreshedFinish);
    expect(startSetup).toHaveBeenCalledTimes(1);

    await act(async () => { releaseSetup(true); });
    expect(refreshedFinish).toBeEnabled();
  });

  it("ignores a late status response after the owner/runtime identity changes", async () => {
    let releaseAlice!: (value: unknown) => void;
    let releaseBob!: (value: unknown) => void;
    const alice: GithubDeveloperAccessClient = {
      status: vi.fn(() => new Promise((resolve) => { releaseAlice = resolve; })),
      startSetup: vi.fn(),
    };
    const bob: GithubDeveloperAccessClient = {
      status: vi.fn(() => new Promise((resolve) => { releaseBob = resolve; })),
      startSetup: vi.fn(),
    };
    const view = render(<GithubDeveloperAccessCard identityKey="alice:primary" client={alice} />);
    view.rerender(<GithubDeveloperAccessCard identityKey="bob:primary" client={bob} />);
    expect(screen.queryByText("octocat")).toBeNull();
    expect(screen.getByText("Checking developer access…")).toBeVisible();

    await act(async () => {
      releaseAlice(readyStatus);
      releaseBob({ ...readyStatus, user: "hubot" });
    });
    expect(screen.getByText("hubot")).toBeVisible();
    expect(screen.queryByText("octocat")).toBeNull();
  });

  it("shows only allowlisted recovery copy when status and setup fail", async () => {
    const client: GithubDeveloperAccessClient = {
      status: vi.fn().mockRejectedValue(new Error("token leaked from /home/alice/.config/gh/hosts.yml")),
      startSetup: vi.fn().mockRejectedValue(new Error("private key leaked")),
    };
    render(<GithubDeveloperAccessCard identityKey="alice:primary" client={client} />);

    expect(await screen.findByText("GitHub developer access is unavailable.")).toBeVisible();
    expect(screen.queryByText(/token leaked|private key leaked|hosts\.yml/i)).toBeNull();
  });
});

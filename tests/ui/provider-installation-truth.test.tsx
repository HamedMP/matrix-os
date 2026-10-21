// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderHarnessInstance, ProviderWorkflowCapability } from "@matrix-os/contracts";
import { HarnessRail } from "../../packages/ui/src/agents-providers/HarnessRail";
import { HarnessWorkflowPanel } from "../../packages/ui/src/agents-providers/HarnessWorkflowPanel";

afterEach(cleanup);
const harness = { id: "openclaw", harness: "openclaw", displayName: "OpenClaw", installState: "missing",
  authState: "authenticated", enabled: true, configuredEnabled: true, accountIds: [], accessSourceId: null,
} as unknown as ProviderHarnessInstance;
const capability = { harnessInstanceId: "openclaw", harness: "openclaw", displayName: "OpenClaw",
  installState: "installed", loginMethods: [], apiKeyProviders: ["openai"], install: true,
  uninstall: false, logs: false,
} as ProviderWorkflowCapability;
const client = { capabilities: vi.fn(), start: vi.fn(), get: vi.fn(), cancel: vi.fn(), logs: vi.fn(), submitKey: vi.fn() };

it("missing executable wins over stale connected workflow status", () => {
  render(<HarnessRail harnesses={[harness]} sources={[]} selectedId={null} disabled={false}
    statusOverride={{ openclaw: "Connected" }} onSelect={vi.fn()} onEnable={vi.fn()} canEnable={() => false} renderDetails={() => null} />);
  expect(screen.getByRole("button", { name: /OpenClaw.*Not installed/ })).toBeInTheDocument();
  expect(screen.queryByText("Connected")).not.toBeInTheDocument();
});

it("unknown executable probe is not reported as unauthenticated installation", () => {
  render(<HarnessRail harnesses={[{ ...harness, installState: "unknown" }]} sources={[]} selectedId={null}
    disabled={false} onSelect={vi.fn()} onEnable={vi.fn()} canEnable={() => false} renderDetails={() => null} />);
  expect(screen.getByText("Checking installation")).toBeInTheDocument();
  expect(screen.queryByText("Not connected")).not.toBeInTheDocument();
});

it("unknown installation suppresses stale API-key methods until a successful probe", () => {
  render(<HarnessWorkflowPanel harness={{ ...harness, installState: "unknown" }} capability={capability}
    client={client} disabled={false} onRefresh={vi.fn()} onOpenTerminal={vi.fn()} />);
  expect(screen.queryByRole("button", { name: /API key/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();
});

it("missing installation offers Install instead of authentication even with stale key capability", () => {
  render(<HarnessWorkflowPanel harness={harness} capability={capability} client={client}
    disabled={false} onRefresh={vi.fn()} onOpenTerminal={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Install" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /API key/ })).not.toBeInTheDocument();
});

it("installed unauthenticated agents retain the connection guide", () => {
  render(<HarnessWorkflowPanel harness={{ ...harness, installState: "installed", authState: "unauthenticated" }}
    capability={capability} client={client} disabled={false} onRefresh={vi.fn()} onOpenTerminal={vi.fn()} />);
  expect(screen.getByRole("button", { name: /API key/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Install" })).not.toBeInTheDocument();
});


it("styles missing and failed installation red while disconnected remains yellow", () => {
  const css = readFileSync("packages/ui/src/agents-providers/agents-providers.css", "utf8");
  expect(css).toMatch(/\.matrix-ap-status-chip\[data-state="not-installed"\], \.matrix-ap-status-chip\[data-state="install-failed"\] \{ color: var\(--matrix-ap-danger\);/);
  expect(css).toMatch(/\.matrix-ap-status-chip\[data-state="not-connected"\] \{ color: var\(--matrix-ap-warning\);/);
  render(<HarnessRail harnesses={[harness]} sources={[]} selectedId={null} disabled={false}
    onSelect={vi.fn()} onEnable={vi.fn()} canEnable={() => false} renderDetails={() => null} />);
  expect(screen.getByText("Not installed")).toHaveAttribute("data-state", "not-installed");
});

// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ProviderAccount,
  ProviderAccessSource,
  ProviderHarnessInstance,
} from "@matrix-os/contracts";
import { AccountsPanel } from "../../packages/ui/src/agents-providers/AccountsPanel";
afterEach(cleanup);
it.each([
  ["ready", "Connected"],
  ["unknown", "Access not verified"],
] as const)(
  "renders actual API-key readiness for a Codex native profile (%s)",
  (state, label) => {
    const account = {
      id: "account",
      displayName: "My API account",
      accessSourceId: "owner_openai_profile",
      authMethod: "api_key",
      authState: "authenticated",
    } as ProviderAccount;
    const source = {
      id: "owner_openai_profile",
      readiness: { state },
      usage: { kind: "unavailable", reason: "unknown" },
    } as ProviderAccessSource;
    const harness = {
      id: "codex",
      harness: "codex",
      displayName: "Codex",
      loginMethods: [],
      accountIds: ["account"],
      accessSourceId: source.id,
      selectedAccountId: "account",
    } as unknown as ProviderHarnessInstance;
    render(
      <AccountsPanel
        harness={harness}
        accounts={[account]}
        sources={[source]}
        allHarnesses={[harness]}
        gatewayPolicy={null}
        attempt={null}
        disabled={false}
        canLogin={false}
        canLogout={false}
        canRemove={false}
        canReassign={false}
        onMutate={vi.fn()}
        onOpenTerminal={vi.fn()}
        onOpenBrowser={vi.fn()}
      />,
    );
    expect(screen.getByTestId("account-account")).toHaveTextContent(
      `${label} · Api Key`,
    );
    if (state === "ready")
      expect(screen.getByTestId("account-account")).not.toHaveTextContent(
        "Access not verified",
      );
  },
);
it("keeps unverified status visible and saves owner account details behind a disclosure", () => {
  const account = {
    id: "account",
    displayName: "Saved owner",
    accessSourceId: "owner_openai_profile",
    authMethod: "api_key",
    authState: "unauthenticated",
  } as ProviderAccount;
  const source = {
    id: "owner_openai_profile",
    readiness: { state: "unknown" },
    usage: { kind: "unavailable", reason: "unknown" },
  } as ProviderAccessSource;
  const harness = {
    id: "codex",
    harness: "codex",
    displayName: "Codex",
    loginMethods: [],
    accountIds: ["account"],
    accessSourceId: source.id,
    selectedAccountId: "account",
  } as unknown as ProviderHarnessInstance;
  render(
    <AccountsPanel
      harness={harness}
      guided
      accounts={[account]}
      sources={[source]}
      allHarnesses={[harness]}
      gatewayPolicy={null}
      attempt={null}
      disabled={false}
      canLogin={false}
      canLogout={false}
      canRemove={false}
      canReassign={false}
      onMutate={vi.fn()}
      onOpenTerminal={vi.fn()}
      onOpenBrowser={vi.fn()}
    />,
  );
  const details = screen.getByText("Saved account details").closest("details");
  expect(details).not.toHaveAttribute("open");
  expect(details).toContainElement(screen.getByTestId("account-account"));
  expect(screen.getByText("Access not verified")).not.toBe(
    details?.querySelector("span"),
  );
});

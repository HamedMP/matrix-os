// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProviderSettingsSnapshotSchema, type ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { AgentsProvidersView } from "../../packages/ui/src/agents-providers/AgentsProvidersView";
import { hasConfiguredConnection } from "../../packages/ui/src/agents-providers/harness-connection";
import nativeOffInput from "../fixtures/claude-native-authenticated-off.json";

afterEach(cleanup);

// Exact synthetic Settings DTO used by the before-fix 4cd product-renderer run.
function fixture() {
  return ProviderSettingsSnapshotSchema.parse(structuredClone(nativeOffInput));
}

function mount(snapshot: ProviderSettingsSnapshot) {
  const onMutate = vi.fn();
  render(<AgentsProvidersView snapshot={snapshot} selectedHarnessId={snapshot.harnesses[0]!.id}
    onSelectHarness={vi.fn()} onRefresh={vi.fn()} onMutate={onMutate}
    onOpenTerminal={vi.fn()} onOpenBrowser={vi.fn()} onAddCredit={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /^Claude Code/ }));
  fireEvent.click(screen.getByText("Advanced configuration"));
  return onMutate;
}

it("shows the same authenticated native account Connected in the header and account card while Off", () => {
  const snapshot = fixture();
  const before = structuredClone(snapshot);
  const onMutate = mount(snapshot);
  expect(screen.getByRole("button", { name: /Claude Code.*Connected/ })).toBeVisible();
  expect(screen.getByTestId("account-owner_claude_profile")).toHaveTextContent("Connected · Terminal");
  expect(screen.getByTestId("account-owner_claude_profile")).not.toHaveTextContent("Not connected");
  expect(screen.getByTestId("account-owner_claude_profile")).toBeVisible();
  expect(hasConfiguredConnection(snapshot.harnesses[0]!, snapshot.accessSources[0]!)).toBe(false);
  expect(snapshot).toEqual(before);
  expect(onMutate).not.toHaveBeenCalled();
});

const negatives: [string, (snapshot: ProviderSettingsSnapshot) => void][] = [
  ["unknown account auth", s => { s.accounts[0]!.authState = "unknown"; }],
  ["expired account auth", s => { s.accounts[0]!.authState = "expired"; }],
  ["unauthenticated account", s => { s.accounts[0]!.authState = "unauthenticated"; }],
  ["unknown native harness auth", s => { s.harnesses[0]!.authState = "unknown"; }],
  ["unauthenticated native harness", s => { s.harnesses[0]!.authState = "unauthenticated"; }],
  ["expired native harness auth", s => { s.harnesses[0]!.authState = "expired"; }],
  ["failed native harness auth", s => { s.harnesses[0]!.authState = "failed"; }],
  ["another selected account", s => { s.harnesses[0]!.selectedAccountId = "other_account"; }],
  ["another harness source", s => { s.harnesses[0]!.accessSourceId = "other_source"; }],
  ["another account source", s => { s.accounts[0]!.accessSourceId = "other_source"; }],
  ["another source account", s => { s.accessSources[0]!.accountId = "other_account"; }],
  ["another account provider", s => { s.accounts[0]!.providerId = "openai"; }],
  ["another route provider", s => { s.harnesses[0]!.route.providerId = "openai"; }],
  ["an API-key route", s => { s.accessSources[0]!.fundingKind = "owner_api_key"; }],
  ["a Matrix-funded route", s => { Object.assign(s.accessSources[0]!, { kind: "matrix_gateway", fundingKind: "matrix_included", accountId: null }); }],
];
it.each(negatives)("does not borrow authenticated native identity for %s", (_name, alter) => {
  const snapshot = fixture();
  alter(snapshot);
  const before = structuredClone(snapshot);
  const onMutate = mount(snapshot);
  expect(screen.getByTestId("account-owner_claude_profile")).toHaveTextContent("Not connected · Terminal");
  expect(snapshot).toEqual(before);
  expect(onMutate).not.toHaveBeenCalled();
});

it("does not label a nonselected account using the selected native account's authentication", () => {
  const snapshot = fixture();
  const other = { ...snapshot.accounts[0]!, id: "other_account", accessSourceId: "other_source", displayName: "Other account" };
  snapshot.accounts.push(other);
  snapshot.accessSources.push({ ...snapshot.accessSources[0]!, id: other.accessSourceId, accountId: other.id });
  snapshot.harnesses[0]!.accountIds.push(other.id);
  const onMutate = mount(snapshot);
  expect(screen.getByTestId("account-owner_claude_profile")).toHaveTextContent("Connected · Terminal");
  expect(screen.getByTestId("account-other_account")).toHaveTextContent("Not connected · Terminal");
  expect(onMutate).not.toHaveBeenCalled();
});

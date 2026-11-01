// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { LocalChatgptSubscription } from "../../packages/ui/src/agents-providers/LocalChatgptSubscription.js";
import type { LocalChatgptPlanClient, LocalChatgptPlanStatus } from "../../packages/ui/src/agents-providers/local-chatgpt-plan-client.js";

afterEach(cleanup);
const connected: LocalChatgptPlanStatus = {
  state: "connected", scope: "this_device", account: { id: "00000000-0000-4000-8000-000000000001", label: "Acceptance account" },
  models: [{ id: "fixture-visible", displayName: "Fixture model" }],
  grant: { enabled: true, background: false, revision: 1 }, bridgeConnected: true, revocation: "none",
};
function client(): LocalChatgptPlanClient {
  return {
    status: vi.fn().mockResolvedValue(connected), connect: vi.fn().mockResolvedValue(connected),
    cancel: vi.fn().mockResolvedValue(connected), disconnect: vi.fn().mockResolvedValue(connected),
    refreshModels: vi.fn().mockResolvedValue(connected),
    setGrant: vi.fn().mockResolvedValue({ ...connected, grant: { enabled: true, background: true, revision: 2 } }),
  };
}

it("makes schedule approval available in Chat without a Settings opt-in or implicit grant write", async () => {
  const native = client();
  render(<LocalChatgptSubscription client={native} disabled={false} readOnly={false} onChanged={vi.fn()}/>);
  expect(await screen.findByText("Approve schedules in Chat. No Settings switch is required.")).toBeVisible();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Revoke background access" })).toBeNull();
  expect(native.setGrant).not.toHaveBeenCalled();
});

it("shows existing general background access truthfully and only offers revocation", async () => {
  const native = client();
  vi.mocked(native.status).mockResolvedValue({ ...connected, grant: { enabled: true, background: true, revision: 2 } });
  render(<LocalChatgptSubscription client={native} disabled={false} readOnly={false} onChanged={vi.fn()}/>);
  expect(await screen.findByText("General background access is currently enabled on this Computer.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Revoke background access" })).toBeEnabled();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(native.setGrant).not.toHaveBeenCalled();
});

it.each([true, false])("restores the native unconfirmed-save warning on a fresh client without widening enabled=%s", async enabled => {
  const native = client();
  vi.mocked(native.status).mockResolvedValue({ ...connected, grantSaveUnconfirmed: true,
    grant: { enabled, background: false, revision: 3 } });
  vi.mocked(native.setGrant).mockResolvedValue({ ...connected, grant: { enabled, background: false, revision: 4 } });
  render(<LocalChatgptSubscription client={native} disabled={false} readOnly={false} onChanged={vi.fn()}/>);
  expect(await screen.findByRole("alert")).toHaveTextContent("Saving could not be confirmed");
  const save = screen.getByRole("button", { name: "Revoke background access" });
  expect(save).toBeEnabled();
  expect(native.setGrant).not.toHaveBeenCalled();
  fireEvent.click(save);
  await waitFor(() => expect(native.setGrant).toHaveBeenCalledWith({ enabled, background: false,
    accountId: connected.account!.id, baseRevision: 3 }, expect.any(AbortSignal)));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

it.each([false, true])("reconciles background=%s after a failed revoke acknowledgement without repeating the write", async background => {
  const native = client();
  vi.mocked(native.status).mockResolvedValue({ ...connected, grant: { enabled: true, background: true, revision: 2 } });
  render(<LocalChatgptSubscription client={native} disabled={false} readOnly={false} onChanged={vi.fn()}/>);
  const revoke = await screen.findByRole("button", { name: "Revoke background access" });
  vi.mocked(native.status).mockResolvedValue({ ...connected, grant: { enabled: true, background, revision: 3 } });
  vi.mocked(native.setGrant).mockRejectedValue(new Error("Private acknowledgement diagnostic"));
  fireEvent.click(revoke);
  expect(await screen.findByRole("alert")).toHaveTextContent("Saving could not be confirmed");
  await waitFor(() => expect(native.status).toHaveBeenCalledTimes(2));
  expect(native.setGrant).toHaveBeenCalledExactlyOnceWith({ enabled: true, background: false,
    accountId: connected.account!.id, baseRevision: 2 }, expect.any(AbortSignal));
  expect(screen.queryByText(/Private acknowledgement/)).toBeNull();
  expect(screen.getByRole("button", { name: "Revoke background access" })).toBeEnabled();
});

it("does not inherit background authority when the displayed account or grant revision changes", async () => {
  const native = client();
  const props = { client: native, disabled: false, readOnly: false, onChanged: vi.fn() };
  const view = render(<LocalChatgptSubscription {...props} refreshRevision={0}/>);
  await screen.findByText("Acceptance account");
  const replacement = { ...connected,
    account: { id: "00000000-0000-4000-8000-000000000002", label: "Replacement account" },
    grant: { enabled: true, background: false, revision: 7 } };
  vi.mocked(native.status).mockResolvedValue(replacement);
  view.rerender(<LocalChatgptSubscription {...props} refreshRevision={1}/>);
  await screen.findByText("Replacement account");
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Revoke background access" })).toBeNull();
  expect(native.setGrant).not.toHaveBeenCalled();
});

it("ignores an old Computer's late permission receipt after the client changes", async () => {
  let settle!: (value: LocalChatgptPlanStatus) => void;
  const old = client(), next = client(), changed = vi.fn();
  vi.mocked(old.status).mockResolvedValue({ ...connected, grant: { enabled: true, background: true, revision: 2 } });
  vi.mocked(old.setGrant).mockImplementation(() => new Promise(resolve => { settle = resolve; }));
  vi.mocked(next.status).mockResolvedValue({ ...connected, account: { id: "00000000-0000-4000-8000-000000000002", label: "Other Computer account" } });
  const props = { disabled: false, readOnly: false, onChanged: changed };
  const view = render(<LocalChatgptSubscription {...props} client={old}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Revoke background access" }));
  view.rerender(<LocalChatgptSubscription {...props} client={next}/>);
  await screen.findByText("Other Computer account");
  await act(async () => settle({ ...connected, grant: { enabled: true, background: true, revision: 2 } }));
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByText("General background access is currently enabled on this Computer.")).toBeNull();
  expect(changed).not.toHaveBeenCalled();
});

it.each(["read-only", "disconnected-peer", "disabled-grant", "missing-models"])("has no grant control for %s sources", async condition => {
  const native = client();
  vi.mocked(native.status).mockResolvedValue({ ...connected,
    bridgeConnected: condition !== "disconnected-peer",
    models: condition === "missing-models" ? [] : connected.models,
    grant: { ...connected.grant, enabled: condition !== "disabled-grant" },
  });
  render(<LocalChatgptSubscription client={native} disabled={false} readOnly={condition === "read-only"} onChanged={vi.fn()}/>);
  await screen.findByText("Acceptance account");
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(native.setGrant).not.toHaveBeenCalled();
});

it("keeps failed revocation explicitly unconfirmed and lets the owner retry saving it without re-enabling access", async () => {
  const native = client();
  vi.mocked(native.status).mockResolvedValue({ ...connected, grant: { enabled: true, background: true, revision: 2 } });
  render(<LocalChatgptSubscription client={native} disabled={false} readOnly={false} onChanged={vi.fn()}/>);
  await screen.findByRole("button", { name: "Revoke background access" });
  vi.mocked(native.status).mockResolvedValue({ ...connected, bridgeConnected: false, grant: { enabled: true, background: false, revision: 3 } });
  vi.mocked(native.setGrant).mockRejectedValueOnce(new Error("Fixture persistence failure"))
    .mockResolvedValue({ ...connected, grant: { enabled: true, background: false, revision: 4 } });
  fireEvent.click(screen.getByRole("button", { name: "Revoke background access" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Saving could not be confirmed/));
  expect(screen.queryByRole("checkbox")).toBeNull();
  const retry = screen.getByRole("button", { name: "Revoke background access" });
  expect(retry).toBeEnabled();
  expect(native.setGrant).toHaveBeenCalledTimes(1);
  fireEvent.click(retry);
  await waitFor(() => expect(native.setGrant).toHaveBeenLastCalledWith({ enabled: true, background: false,
    accountId: "00000000-0000-4000-8000-000000000001", baseRevision: 3 }, expect.any(AbortSignal)));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(native.setGrant).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Revoke background access" })).toBeNull();
});

it.each(["disconnected-peer", "missing-models"])("allows revocation but no new opt-in for an already granted %s source", async condition => {
  const native = client();
  vi.mocked(native.status).mockResolvedValue({ ...connected, state: condition === "missing-models" ? "error" : "connected",
    models: condition === "missing-models" ? [] : connected.models, bridgeConnected: false,
    grant: { enabled: true, background: true, revision: 2 } });
  vi.mocked(native.setGrant).mockResolvedValue({ ...connected, grant: { enabled: true, background: false, revision: 3 } });
  render(<LocalChatgptSubscription client={native} disabled={false} readOnly={false} onChanged={vi.fn()}/>);
  await screen.findByRole("button", { name: "Revoke background access" });
  fireEvent.click(screen.getByRole("button", { name: "Revoke background access" }));
  await waitFor(() => expect(native.setGrant).toHaveBeenCalledWith({ enabled: true, background: false,
    accountId: "00000000-0000-4000-8000-000000000001", baseRevision: 2 }, expect.any(AbortSignal)));
  expect(await screen.findByText("Approve schedules in Chat. No Settings switch is required.")).toBeVisible();
});

it("retains an unconfirmed revocation across a Settings refresh until the owner explicitly saves it", async () => {
  const native = client();
  vi.mocked(native.status).mockResolvedValue({ ...connected, grant: { enabled: true, background: true, revision: 2 } });
  const props = { client: native, disabled: false, readOnly: false, onChanged: vi.fn() };
  const view = render(<LocalChatgptSubscription {...props} refreshRevision={0}/>);
  await screen.findByRole("button", { name: "Revoke background access" });
  vi.mocked(native.setGrant).mockRejectedValue(new Error("Fixture disk failure"));
  vi.mocked(native.status).mockResolvedValue({ ...connected, bridgeConnected: false, grant: { enabled: true, background: false, revision: 3 } });
  fireEvent.click(screen.getByRole("button", { name: "Revoke background access" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Saving could not be confirmed/));
  view.rerender(<LocalChatgptSubscription {...props} refreshRevision={1}/>);
  await waitFor(() => expect(native.status).toHaveBeenCalledTimes(3));
  expect(screen.getByRole("alert")).toHaveTextContent(/Saving could not be confirmed/);
  expect(screen.getByRole("button", { name: "Revoke background access" })).toBeEnabled();
  expect(native.setGrant).toHaveBeenCalledTimes(1);
});

it.each(["succeeds", "fails"])("keeps unconfirmed revocation separate when unrelated model refresh %s", async outcome => {
  const native = client();
  vi.mocked(native.status).mockResolvedValueOnce({ ...connected, grant: { enabled: true, background: true, revision: 2 } })
    .mockResolvedValue({ ...connected, models: [], bridgeConnected: false, bridgeFailure: "device_conflict",
      grant: { enabled: true, background: false, revision: 3 } });
  vi.mocked(native.setGrant).mockRejectedValue(new Error("Fixture persistence failure"));
  if (outcome === "succeeds") vi.mocked(native.refreshModels).mockResolvedValue({ ...connected, grant: { enabled: true, background: false, revision: 3 } });
  else vi.mocked(native.refreshModels).mockRejectedValue(new Error("Fixture catalog failure"));
  render(<LocalChatgptSubscription client={native} disabled={false} readOnly={false} onChanged={vi.fn()}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Revoke background access" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Saving could not be confirmed/));
  fireEvent.click(screen.getByRole("button", { name: "Check subscription models" }));
  await waitFor(() => expect(native.refreshModels).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByRole("button", { name: "Revoke background access" })).toBeEnabled());
  expect(screen.getByRole("alert")).toHaveTextContent(/Saving could not be confirmed/);
  expect(native.setGrant).toHaveBeenCalledTimes(1);
});

it.each(["refresh", "poll"])("preserves the explicit revoke retry when a later %s status read fails", async mode => {
  const native = client();
  const before = { ...connected, grant: { enabled: true, background: true, revision: 2 } };
  const stopped: LocalChatgptPlanStatus = { ...connected, bridgeConnected: false,
    ...(mode === "refresh" ? { bridgeFailure: "device_conflict" as const } : {}),
    grant: { enabled: true, background: false, revision: 3 } };
  vi.mocked(native.status).mockResolvedValueOnce(before).mockResolvedValueOnce(stopped)
    .mockRejectedValue(new Error("Fixture status unavailable"));
  vi.mocked(native.setGrant).mockRejectedValue(new Error("Fixture persistence failure"));
  const props = { client: native, disabled: false, readOnly: false, onChanged: vi.fn() };
  const view = render(<LocalChatgptSubscription {...props} refreshRevision={0}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Revoke background access" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Saving could not be confirmed/));
  if (mode === "refresh") view.rerender(<LocalChatgptSubscription {...props} refreshRevision={1}/>);
  await waitFor(() => expect(native.status).toHaveBeenCalledTimes(3), { timeout: 3000 });
  expect(screen.getByRole("alert")).toHaveTextContent(/Saving could not be confirmed/);
  expect(screen.getByRole("button", { name: "Revoke background access" })).toBeEnabled();
  expect(native.setGrant).toHaveBeenCalledTimes(1);
  vi.mocked(native.status).mockResolvedValue(stopped);
  view.rerender(<LocalChatgptSubscription {...props} refreshRevision={2}/>);
  await waitFor(() => expect(native.status).toHaveBeenCalledTimes(4));
  expect(screen.getByRole("alert")).toHaveTextContent(/Saving could not be confirmed/);
  vi.mocked(native.setGrant).mockResolvedValue({ ...connected, grant: { enabled: true, background: false, revision: 4 } });
  fireEvent.click(screen.getByRole("button", { name: "Revoke background access" }));
  await waitFor(() => expect(native.setGrant).toHaveBeenLastCalledWith({ enabled: true, background: false,
    accountId: connected.account!.id, baseRevision: 3 }, expect.any(AbortSignal)));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

it("does not claim a failed revocation stopped access when authority readback also fails", async () => {
  const native = client();
  vi.mocked(native.status).mockResolvedValue({ ...connected, grant: { enabled: true, background: true, revision: 2 } });
  render(<LocalChatgptSubscription client={native} disabled={false} readOnly={false} onChanged={vi.fn()}/>);
  await screen.findByRole("button", { name: "Revoke background access" });
  vi.mocked(native.setGrant).mockRejectedValue(new Error("Fixture write failure"));
  vi.mocked(native.status).mockRejectedValue(new Error("Fixture read failure"));
  fireEvent.click(screen.getByRole("button", { name: "Revoke background access" }));
  await waitFor(() => expect(native.status).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("alert")).toHaveTextContent(/Saving could not be confirmed/);
  expect(screen.getByRole("alert")).not.toHaveTextContent(/access is stopped/);
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.getByRole("button", { name: "Revoke background access" })).toBeEnabled();
  expect(native.setGrant).toHaveBeenCalledTimes(1);
});

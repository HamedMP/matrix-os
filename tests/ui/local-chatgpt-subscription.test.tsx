// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { LocalChatgptSubscription } from "../../packages/ui/src/agents-providers/LocalChatgptSubscription.js";
import type { LocalChatgptPlanClient, LocalChatgptPlanStatus } from "../../packages/ui/src/agents-providers/local-chatgpt-plan-client.js";
import { YourSubscriptions } from "../../packages/ui/src/agents-providers/YourSubscriptions.js";
afterEach(cleanup);
const disconnected: LocalChatgptPlanStatus = { state: "disconnected", scope: "this_device", models: [], grant: { revision: 0, enabled: false, background: false }, bridgeConnected: false, revocation: "none" };
const connected: LocalChatgptPlanStatus = { ...disconnected, state: "connected", account: { id: "selected-account", label: "Owner account" }, models: [{ id: "gpt-owner", displayName: "Owner GPT" }], grant: { revision: 1, enabled: true, background: false }, bridgeConnected: true };
function client(value = disconnected): LocalChatgptPlanClient {
  return { status: vi.fn().mockResolvedValue(value), connect: vi.fn().mockResolvedValue(connected), cancel: vi.fn().mockResolvedValue(disconnected), disconnect: vi.fn().mockResolvedValue(disconnected), refreshModels: vi.fn().mockResolvedValue(connected), setGrant: vi.fn().mockResolvedValue({ ...connected, grant: { revision: 1, enabled: true, background: false } }) };
}
it("places the real native subscription source in Matrix AI separately from Codex key management", async () => {
  render(<YourSubscriptions snapshot={{ access: { mode: "writable" }, harnesses: [] } as never} capabilities={[]} client={undefined} localChatgptClient={client()} operationIds={{}} workflowStatus={{}} forbidden={false} disabled={false} onOpen={vi.fn()} onRefresh={vi.fn()}/>);
  expect(await screen.findByRole("button", { name: "Continue with ChatGPT" })).toBeEnabled();
});
it("does not advertise a login action in unsupported Web or Canvas surfaces", () => {
  render(<LocalChatgptSubscription disabled={false} readOnly={false} onChanged={vi.fn()}/>);
  expect(screen.queryByRole("button", { name: "Continue with ChatGPT" })).toBeNull();
  expect(screen.getByText(/Available in Electron Desktop/)).toBeVisible();
});
it("connecting authorizes interactive Bots without extra checkbox or grant controls", async () => {
  const native = client(); const changed = vi.fn();
  render(<LocalChatgptSubscription client={native} disabled={false} readOnly={false} onChanged={changed}/>);
  await waitFor(() => expect(screen.getByRole("button", { name: "Continue with ChatGPT" })).toBeEnabled());
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Continue with ChatGPT" }));
  await screen.findByText("Owner account");
  expect(native.connect).toHaveBeenCalledWith({ purpose: "personal_local" }, expect.any(AbortSignal));
  expect(native.setGrant).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Use for Bots" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Stop Bot use" })).toBeNull();
  expect(screen.getByText("Available for interactive Bots on this Computer.")).toBeVisible();
  expect(changed).toHaveBeenCalledTimes(1);
});
it("offers explicit reconnect for an existing disabled account without changing grants on read", async () => {
  const native = client({ ...connected, grant: { revision: 3, enabled: false, background: false } });
  render(<LocalChatgptSubscription client={native} disabled={false} readOnly={false} onChanged={vi.fn()}/>);
  await screen.findByText("Owner account");
  expect(native.connect).not.toHaveBeenCalled(); expect(native.setGrant).not.toHaveBeenCalled();
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Reconnect ChatGPT" }));
  await waitFor(() => expect(native.connect).toHaveBeenCalledWith({ purpose: "personal_local" }, expect.any(AbortSignal)));
  expect(await screen.findByText("Available for interactive Bots on this Computer.")).toBeVisible();
  expect(native.setGrant).not.toHaveBeenCalled();
});
it("keeps failed reconnect visibly disabled and leaves read-only accounts untouched", async () => {
  const disabled = { ...connected, grant: { revision: 3, enabled: false, background: false } };
  const native = client(disabled); vi.mocked(native.connect).mockRejectedValue(new Error("private upstream detail"));
  const view = render(<LocalChatgptSubscription client={native} disabled={false} readOnly={false} onChanged={vi.fn()}/>);
  await screen.findByText("Owner account");
  fireEvent.click(screen.getByRole("button", { name: "Reconnect ChatGPT" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("ChatGPT connection could not be updated");
  expect(screen.queryByText("Available for interactive Bots on this Computer.")).toBeNull();
  expect(screen.queryByText(/private upstream/)).toBeNull();
  view.rerender(<LocalChatgptSubscription client={native} disabled={false} readOnly={true} onChanged={vi.fn()}/>);
  expect(screen.queryByRole("button", { name: "Reconnect ChatGPT" })).toBeNull();
  expect(native.connect).toHaveBeenCalledTimes(1); expect(native.setGrant).not.toHaveBeenCalled();
});
it("does not claim availability while disconnected from the selected Computer", async () => {
  render(<LocalChatgptSubscription client={client({ ...connected, bridgeConnected: false })} disabled={false} readOnly={false} onChanged={vi.fn()}/>);
  await screen.findByText("Owner account");
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByText("Available for interactive Bots on this Computer.")).toBeNull();
});
it("preserves the connected account and safe error after a failed disconnect", async () => {
  const native = client(connected); vi.mocked(native.disconnect).mockRejectedValue(new Error("private secret error"));
  render(<LocalChatgptSubscription client={native} disabled={false} readOnly={false} onChanged={vi.fn()}/>);
  await screen.findByText("Owner account"); fireEvent.click(screen.getByRole("button", { name: "Disconnect ChatGPT" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("ChatGPT connection could not be updated");
  expect(screen.getByText("Owner account")).toBeVisible();
  expect(screen.queryByText(/private secret/)).toBeNull();
});
it("fences late receipt and consent on owner or Computer replacement", async () => {
  let settle!: (value: LocalChatgptPlanStatus) => void;
  const old = client(); vi.mocked(old.connect).mockImplementation(() => new Promise(resolve => { settle = resolve; }));
  const changed = vi.fn(); const props = { disabled: false, readOnly: false, onChanged: changed };
  const view = render(<LocalChatgptSubscription {...props} client={old}/>);
  await waitFor(() => expect(old.status).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "Continue with ChatGPT" }));
  view.rerender(<LocalChatgptSubscription {...props} client={client()}/>);
  await act(async () => settle(connected));
  expect(screen.queryByText("Owner account")).toBeNull(); expect(changed).not.toHaveBeenCalled();
  expect(screen.queryByRole("checkbox")).toBeNull();
});
it("reports unconfirmed provider revocation without pretending sign-out completed", async () => {
  render(<LocalChatgptSubscription client={client({ ...disconnected, revocation: "unconfirmed" })} disabled={false} readOnly={false} onChanged={vi.fn()}/>);
  expect(await screen.findByText(/Provider sign-out could not be confirmed/)).toBeVisible();
});
it("polls asynchronous local login until default interactive Bot connection is ready", async () => {
  const native = client(), changed = vi.fn();
  vi.mocked(native.connect).mockResolvedValue({ ...disconnected, state: "connecting" });
  render(<LocalChatgptSubscription client={native} disabled={false} readOnly={false} onChanged={changed}/>);
  await waitFor(() => expect(native.status).toHaveBeenCalledTimes(1));
  vi.mocked(native.status).mockResolvedValueOnce({ ...connected, bridgeConnected: false }).mockResolvedValue(connected);
  vi.useFakeTimers();
  try {
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Continue with ChatGPT" })));
    expect(screen.getByRole("button", { name: "Cancel ChatGPT connection" })).toBeEnabled();
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(screen.queryByText("Available for interactive Bots on this Computer.")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(screen.getByText("Available for interactive Bots on this Computer.")).toBeVisible();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(native.setGrant).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});
it("lets cancellation fence a late native login receipt", async () => {
  const native = client(); let settle!: (value: LocalChatgptPlanStatus) => void;
  vi.mocked(native.connect).mockImplementation(() => new Promise(resolve => { settle = resolve; }));
  render(<LocalChatgptSubscription client={native} disabled={false} readOnly={false} onChanged={vi.fn()}/>);
  await waitFor(() => expect(native.status).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "Continue with ChatGPT" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel ChatGPT connection" }));
  await waitFor(() => expect(native.cancel).toHaveBeenCalled());
  await act(async () => settle(connected));
  expect(screen.queryByText("Owner account")).toBeNull();
});
it("does not claim Bot availability when a connected account loses its model catalog", async () => {
  render(<LocalChatgptSubscription client={client({ ...connected, models: [], grant: { revision: 2, enabled: true, background: false } })} disabled={false} readOnly={false} onChanged={vi.fn()}/>);
  await screen.findByText("Owner account");
  expect(screen.queryByText("Available for interactive Bots on this Computer.")).toBeNull();
  expect(screen.getByText(/No subscription models are available/)).toBeVisible();
});

it("keeps a healthy connected card to account, availability and disconnect", async () => {
  render(<LocalChatgptSubscription client={client(connected)} disabled={false} readOnly={false} onChanged={vi.fn()}/>);
  await screen.findByText("Owner account");
  expect(screen.getByRole("button", { name: "Disconnect ChatGPT" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Check connection" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Check subscription models" })).toBeNull();
  expect(screen.queryByText(/Usage unavailable/)).toBeNull();
});
it("offers a model check only when a connected catalog is missing", async () => {
  const native = client({ ...connected, models: [] });
  render(<LocalChatgptSubscription client={native} disabled={false} readOnly={false} onChanged={vi.fn()}/>);
  await screen.findByText("Owner account");
  fireEvent.click(screen.getByRole("button", { name: "Check subscription models" }));
  await waitFor(() => expect(native.refreshModels).toHaveBeenCalledWith(expect.any(AbortSignal)));
  expect(await screen.findByText("Available for interactive Bots on this Computer.")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Check subscription models" })).toBeNull();
  expect(native.connect).not.toHaveBeenCalled(); expect(native.setGrant).not.toHaveBeenCalled();
});

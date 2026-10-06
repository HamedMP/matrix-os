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
const connected: LocalChatgptPlanStatus = { ...disconnected, state: "connected", account: { id: "selected-account", label: "Owner account" }, models: [{ id: "gpt-owner", displayName: "Owner GPT" }], bridgeConnected: true };
function client(value = disconnected): LocalChatgptPlanClient {
  return { status: vi.fn().mockResolvedValue(value), connect: vi.fn().mockResolvedValue(connected), cancel: vi.fn().mockResolvedValue(disconnected), disconnect: vi.fn().mockResolvedValue(disconnected), refreshModels: vi.fn().mockResolvedValue(connected), setGrant: vi.fn().mockResolvedValue({ ...connected, grant: { revision: 1, enabled: true, background: false } }) };
}
it("places the real native subscription source in Matrix AI separately from Codex key management", async () => {
  render(<YourSubscriptions snapshot={{ access: { mode: "writable" }, harnesses: [] } as never} capabilities={[]} client={undefined} localChatgptClient={client()} operationIds={{}} workflowStatus={{}} forbidden={false} disabled={false} onOpen={vi.fn()} onRefresh={vi.fn()}/>);
  expect(await screen.findByRole("button", { name: "Continue with ChatGPT" })).toBeDisabled();
});
it("does not advertise a login action in unsupported Web or Canvas surfaces", () => {
  render(<LocalChatgptSubscription disabled={false} readOnly={false} onChanged={vi.fn()}/>);
  expect(screen.queryByRole("button", { name: "Continue with ChatGPT" })).toBeNull();
  expect(screen.getByText(/Available in Electron Desktop/)).toBeVisible();
});
it("requires local personal consent and does not implicitly grant Bot or background use on login", async () => {
  const native = client(); const changed = vi.fn();
  render(<LocalChatgptSubscription client={native} disabled={false} readOnly={false} onChanged={changed}/>);
  await waitFor(() => expect(native.status).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("checkbox", { name: "Use my ChatGPT plan on this personal device" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue with ChatGPT" }));
  await screen.findByText("Owner account");
  expect(native.connect).toHaveBeenCalledWith({ purpose: "personal_local" }, expect.any(AbortSignal));
  expect(native.setGrant).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Use for Bots" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: /Allow interactive Bots/ }));
  fireEvent.click(screen.getByRole("button", { name: "Use for Bots" }));
  await screen.findByRole("button", { name: "Stop Bot use" });
  expect(native.setGrant).toHaveBeenCalledWith({ enabled: true, background: false }, expect.any(AbortSignal));
  expect(changed).toHaveBeenCalledTimes(2);
});
it("never enables Bot consent when disconnected from the selected Computer", async () => {
  render(<LocalChatgptSubscription client={client({ ...connected, bridgeConnected: false })} disabled={false} readOnly={false} onChanged={vi.fn()}/>);
  await screen.findByText("Owner account");
  expect(screen.getByRole("checkbox", { name: /Allow interactive Bots/ })).toBeDisabled();
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
  fireEvent.click(screen.getByRole("checkbox", { name: "Use my ChatGPT plan on this personal device" })); fireEvent.click(screen.getByRole("button", { name: "Continue with ChatGPT" }));
  view.rerender(<LocalChatgptSubscription {...props} client={client()}/>);
  await act(async () => settle(connected));
  expect(screen.queryByText("Owner account")).toBeNull(); expect(changed).not.toHaveBeenCalled();
  expect(screen.getByRole("checkbox", { name: "Use my ChatGPT plan on this personal device" })).not.toBeChecked();
});
it("reports unconfirmed provider revocation without pretending sign-out completed", async () => {
  render(<LocalChatgptSubscription client={client({ ...disconnected, revocation: "unconfirmed" })} disabled={false} readOnly={false} onChanged={vi.fn()}/>);
  expect(await screen.findByText(/Provider sign-out could not be confirmed/)).toBeVisible();
});
it("polls asynchronous local login through no-grant registration before allowing Bot consent", async () => {
  const native = client(), changed = vi.fn();
  vi.mocked(native.connect).mockResolvedValue({ ...disconnected, state: "connecting" });
  render(<LocalChatgptSubscription client={native} disabled={false} readOnly={false} onChanged={changed}/>);
  await waitFor(() => expect(native.status).toHaveBeenCalledTimes(1));
  vi.mocked(native.status).mockResolvedValueOnce({ ...connected, bridgeConnected: false }).mockResolvedValue(connected);
  vi.useFakeTimers();
  try {
    fireEvent.click(screen.getByRole("checkbox", { name: "Use my ChatGPT plan on this personal device" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Continue with ChatGPT" })));
    expect(screen.getByRole("button", { name: "Cancel ChatGPT connection" })).toBeEnabled();
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(screen.getByRole("checkbox", { name: /Allow interactive Bots/ })).toBeDisabled();
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(screen.getByRole("checkbox", { name: /Allow interactive Bots/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Use for Bots" })).toBeDisabled();
    expect(native.setGrant).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});
it("lets cancellation fence a late native login receipt", async () => {
  const native = client(); let settle!: (value: LocalChatgptPlanStatus) => void;
  vi.mocked(native.connect).mockImplementation(() => new Promise(resolve => { settle = resolve; }));
  render(<LocalChatgptSubscription client={native} disabled={false} readOnly={false} onChanged={vi.fn()}/>);
  await waitFor(() => expect(native.status).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("checkbox", { name: "Use my ChatGPT plan on this personal device" }));
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

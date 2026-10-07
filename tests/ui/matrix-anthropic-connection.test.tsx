// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { MatrixAnthropicConnection } from "@matrix-os/contracts";
import type { MatrixAnthropicConnectionClient } from "../../packages/ui/src/agents-providers/matrix-anthropic-connection-client.js";
import { MatrixAnthropicConnectionCard } from "../../packages/ui/src/agents-providers/MatrixAnthropicConnectionCard.js";
import { YourSubscriptions } from "../../packages/ui/src/agents-providers/YourSubscriptions.js";
afterEach(cleanup);
const generation = "47ed04c6-d276-4ec2-a9f1-f7b2e071cb3c";
const disconnected: MatrixAnthropicConnection = {
  connectionId: "matrix_anthropic_api", providerId: "anthropic", executionKind: "direct_pi", billingKind: "api_key",
  revision: 0, enabled: false, credentialGeneration: null, sourceCredentialGeneration: null,
  state: "disconnected", models: [], actions: ["connect"], checkedAt: null, staleAfter: null,
  supports: { rootChat: true, recipeBots: true },
};
const connected: MatrixAnthropicConnection = {
  ...disconnected, revision: 1, enabled: true, credentialGeneration: generation, sourceCredentialGeneration: generation,
  state: "ready", models: [{ id: "claude-owner", displayName: "Owner Claude" }], actions: ["connect", "refresh", "disconnect"],
  checkedAt: "2026-10-07T10:00:00.000Z", staleAfter: "2026-10-07T10:05:00.000Z",
};
function client(status = disconnected): MatrixAnthropicConnectionClient {
  return { status: vi.fn().mockResolvedValue(status), connect: vi.fn().mockResolvedValue(connected),
    refresh: vi.fn().mockResolvedValue(connected), disconnect: vi.fn().mockResolvedValue({ ...disconnected, revision: 2, credentialGeneration: generation }) };
}
function setup(native: MatrixAnthropicConnectionClient, changed = vi.fn()) {
  return render(<MatrixAnthropicConnectionCard client={native} disabled={false} readOnly={false} onChanged={changed}/>);
}
async function fillKey() {
  fireEvent.click(await screen.findByRole("button", { name: "Connect Claude" }));
  fireEvent.change(screen.getByLabelText("Anthropic API key"), { target: { value: "sk-ant-synthetic-owner-key" } });
}

it("connects only through the Matrix API source with current CAS, no separate Bot grant", async () => {
  const native = client(); const changed = vi.fn(); setup(native, changed);
  expect(screen.getByText(/Anthropic bills API requests/)).toBeVisible();
  expect(screen.queryByRole("checkbox")).toBeNull();
  await fillKey();
  expect(screen.getByLabelText("Anthropic API key")).toHaveAttribute("type", "password");
  fireEvent.click(screen.getByRole("button", { name: "Connect Claude" }));
  await screen.findByText("Connected");
  expect(native.connect).toHaveBeenCalledWith({ expectedRevision: 0, expectedCredentialGeneration: null,
    idempotencyKey: expect.any(String), apiKey: "sk-ant-synthetic-owner-key" }, expect.any(AbortSignal));
  expect(changed).toHaveBeenCalledOnce();
  expect(screen.queryByLabelText("Anthropic API key")).toBeNull();
});

it("failed replacement keeps the current connection and uses safe error copy", async () => {
  const native = client(connected); native.connect = vi.fn().mockRejectedValue(new Error("private-key /owner/path"));
  const changed = vi.fn(); setup(native, changed);
  fireEvent.click(await screen.findByRole("button", { name: "Change API key" }));
  fireEvent.change(screen.getByLabelText("Anthropic API key"), { target: { value: "sk-ant-replacement-synthetic" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect Claude" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Claude connection could not be updated. Check again.");
  expect(screen.getByText("Connected")).toBeVisible();
  expect(screen.queryByText(/private-key/)).toBeNull();
  expect(changed).not.toHaveBeenCalled();
});

it.each(["cancel and reopen", "change the submitted key"])("reconciles a Connect committed before response loss before %s", async recovery => {
  let saved = disconnected;
  const native = client(); const changed = vi.fn();
  native.status = vi.fn(async () => saved);
  native.connect = vi.fn(async input => {
    if (input.expectedRevision !== saved.revision || input.expectedCredentialGeneration !== saved.credentialGeneration) {
      throw new Error("ConnectionConflict");
    }
    if (saved.revision === 0) {
      saved = connected;
      throw new Error("ResponseLostAfterPublication");
    }
    saved = { ...connected, revision: 2, credentialGeneration: "cd7a1a9b-93eb-4d23-bdaa-3033829b5a77",
      sourceCredentialGeneration: "cd7a1a9b-93eb-4d23-bdaa-3033829b5a77" };
    return saved;
  });
  render(<MatrixAnthropicConnectionCard client={native} initialStatus={disconnected}
    disabled={false} readOnly={false} onChanged={changed}/>); await fillKey();
  fireEvent.click(screen.getByRole("button", { name: "Connect Claude" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled());
  expect(screen.getByText("Connected")).toBeVisible();
  expect(changed).toHaveBeenCalledOnce();
  if (recovery === "cancel and reopen") {
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Change API key" }));
  }
  fireEvent.change(screen.getByLabelText("Anthropic API key"), { target: { value: "sk-ant-replacement-synthetic" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect Claude" }));
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
  expect(native.connect).toHaveBeenLastCalledWith({ expectedRevision: 1, expectedCredentialGeneration: generation,
    idempotencyKey: expect.any(String), apiKey: "sk-ant-replacement-synthetic" }, expect.any(AbortSignal));
  expect(screen.queryByLabelText("Anthropic API key")).toBeNull();
});

it("preserves the exact Connect retry when reconciliation proves no publication", async () => {
  const native = client(connected); const changed = vi.fn();
  native.connect = vi.fn().mockRejectedValueOnce(new Error("DiscoveryUnavailable")).mockResolvedValue(connected);
  render(<MatrixAnthropicConnectionCard client={native} initialStatus={connected}
    disabled={false} readOnly={false} onChanged={changed}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Change API key" }));
  fireEvent.change(screen.getByLabelText("Anthropic API key"), { target: { value: "sk-ant-replacement-synthetic" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect Claude" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled());
  expect(native.status).toHaveBeenCalledOnce();
  expect(screen.getByText("Connected")).toBeVisible();
  expect(changed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Connect Claude" }));
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(vi.mocked(native.connect).mock.calls[1][0]).toEqual(vi.mocked(native.connect).mock.calls[0][0]);
});

it("fences a lost Connect reconciliation when the Computer changes", async () => {
  const old = client(); const next = client(); const changed = vi.fn();
  let settle!: (value: MatrixAnthropicConnection) => void;
  old.status = vi.fn().mockResolvedValueOnce(disconnected).mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
  old.connect = vi.fn().mockRejectedValue(new Error("ResponseLostAfterPublication"));
  const view = setup(old, changed); await fillKey();
  fireEvent.click(screen.getByRole("button", { name: "Connect Claude" }));
  await waitFor(() => expect(old.status).toHaveBeenCalledTimes(2));
  const reconciliationSignal = vi.mocked(old.status).mock.calls[1][0];
  view.rerender(<MatrixAnthropicConnectionCard client={next} disabled={false} readOnly={false} onChanged={changed}/>);
  expect(reconciliationSignal.aborted).toBe(true);
  await act(async () => { settle(connected); });
  await screen.findByText("Not connected");
  expect(screen.queryByText("Connected")).toBeNull();
  expect(screen.queryByLabelText("Anthropic API key")).toBeNull();
  expect(changed).not.toHaveBeenCalled();
});

it("disconnect uses exact current source authority and reports the accepted mutation", async () => {
  const native = client(connected); const changed = vi.fn(); setup(native, changed);
  fireEvent.click(await screen.findByRole("button", { name: "Disconnect Claude" }));
  await screen.findByText("Not connected");
  expect(native.disconnect).toHaveBeenCalledWith({ expectedRevision: 1, expectedCredentialGeneration: generation,
    idempotencyKey: expect.any(String) }, expect.any(AbortSignal));
  expect(changed).toHaveBeenCalledOnce();
});

it("ignores old-Computer completion and clears the transient key immediately", async () => {
  const old = client(); const next = client(); const changed = vi.fn();
  let settle!: (value: MatrixAnthropicConnection) => void;
  old.connect = vi.fn(() => new Promise(resolve => { settle = resolve; }));
  const view = setup(old, changed); await fillKey();
  fireEvent.click(screen.getByRole("button", { name: "Connect Claude" }));
  view.rerender(<MatrixAnthropicConnectionCard client={next} disabled={false} readOnly={false} onChanged={changed}/>);
  expect(screen.queryByDisplayValue("sk-ant-synthetic-owner-key")).toBeNull();
  await act(async () => { settle(connected); });
  await screen.findByText("Not connected");
  expect(screen.queryByText("Connected")).toBeNull();
  expect(changed).not.toHaveBeenCalled();
});

it("does not advertise unavailable or nonowner connection actions", async () => {
  const native = client({ ...disconnected, state: "read_only", actions: [], supports: { rootChat: false, recipeBots: false } });
  setup(native); await screen.findByText("Read only");
  expect(screen.queryByRole("button", { name: "Connect Claude" })).toBeNull();
  expect(native.connect).not.toHaveBeenCalled();
});

it("refresh cannot overwrite a later accepted connect", async () => {
  const native = client(); let settle!: (value: MatrixAnthropicConnection) => void;
  native.status = vi.fn().mockResolvedValueOnce(disconnected).mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
  const changed = vi.fn(); const view = setup(native, changed);
  await screen.findByText("Not connected");
  view.rerender(<MatrixAnthropicConnectionCard client={native} disabled={false} readOnly={false} refreshRevision={1} onChanged={changed}/>);
  await fillKey(); fireEvent.click(screen.getByRole("button", { name: "Connect Claude" }));
  await screen.findByText("Connected");
  await act(async () => { settle(disconnected); });
  expect(screen.getByText("Connected")).toBeVisible();
  expect(changed).toHaveBeenCalledOnce();
});

it("does not refetch on unrelated renders or automatically pick a model", async () => {
  const native = client(connected); const view = setup(native);
  await screen.findByText("Connected");
  view.rerender(<MatrixAnthropicConnectionCard client={native} disabled={true} readOnly={false} onChanged={vi.fn()}/>);
  await waitFor(() => expect(native.status).toHaveBeenCalledOnce());
  expect(native.connect).not.toHaveBeenCalled();
  expect(native.refresh).not.toHaveBeenCalled();
  expect(screen.queryByRole("combobox")).toBeNull();
});

it("uses the supplied V3 connection observation without a separate status read", async () => {
  const native = client(); const changed = vi.fn();
  const view = render(<MatrixAnthropicConnectionCard client={native} initialStatus={connected}
    disabled={false} readOnly={false} onChanged={changed}/>);
  expect(screen.getByText("Connected")).toBeVisible();
  view.rerender(<MatrixAnthropicConnectionCard client={native} initialStatus={connected} refreshRevision={1}
    disabled={false} readOnly={false} onChanged={changed}/>);
  await act(async () => {});
  expect(native.status).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Disconnect Claude" }));
  await screen.findByText("Not connected");
  expect(native.disconnect).toHaveBeenCalledWith({ expectedRevision: 1, expectedCredentialGeneration: generation,
    idempotencyKey: expect.any(String) }, expect.any(AbortSignal));
});

it("keeps unavailable V3 connection observations unavailable without probing", async () => {
  const native = client(connected);
  render(<MatrixAnthropicConnectionCard client={native} initialStatus={null}
    disabled={false} readOnly={false} onChanged={vi.fn()}/>);
  expect(screen.getByText("Unavailable")).toBeVisible();
  await act(async () => {});
  expect(native.status).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Connect Claude" })).toBeNull();
});

it("a newer V3 observation supersedes a completed local mutation receipt", async () => {
  const native = client(); const changed = vi.fn();
  const view = render(<MatrixAnthropicConnectionCard client={native} initialStatus={disconnected}
    disabled={false} readOnly={false} onChanged={changed}/>);
  await fillKey(); fireEvent.click(screen.getByRole("button", { name: "Connect Claude" }));
  await screen.findByText("Connected");
  const observed: MatrixAnthropicConnection = { ...connected, revision: 2, state: "refresh_required", models: [] };
  view.rerender(<MatrixAnthropicConnectionCard client={native} initialStatus={observed}
    disabled={false} readOnly={false} onChanged={changed}/>);
  expect(screen.getByText("Check connection")).toBeVisible();
  expect(screen.queryByText(/Available for chats/)).toBeNull();
  expect(native.status).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Disconnect Claude" }));
  await screen.findByText("Not connected");
  expect(native.disconnect).toHaveBeenCalledWith({ expectedRevision: 2, expectedCredentialGeneration: generation,
    idempotencyKey: expect.any(String) }, expect.any(AbortSignal));
});

it("places the API connection inside Matrix AI without invoking native Claude setup", async () => {
  const native = client(); const openNative = vi.fn(); const changed = vi.fn();
  render(<YourSubscriptions snapshot={{ access: { mode: "writable" }, harnesses: [], matrixAnthropicConnection: disconnected } as never} capabilities={[]}
    matrixAnthropicClient={native} operationIds={{}} workflowStatus={{}} forbidden={false} disabled={false} onOpen={openNative} onRefresh={changed}/>);
  const connections = screen.getByRole("region", { name: "Your connections" });
  expect(within(connections).getAllByRole("article")).toHaveLength(2);
  expect(within(connections).getByRole("article", { name: "Claude API connection" })).toBeVisible();
  await fillKey(); fireEvent.click(screen.getByRole("button", { name: "Connect Claude" }));
  await screen.findByText("Connected");
  expect(native.connect).toHaveBeenCalledOnce();
  expect(changed).toHaveBeenCalledOnce();
  expect(openNative).not.toHaveBeenCalled();
  expect(within(connections).queryByRole("checkbox")).toBeNull();
});


it("withdraws readiness and reconciles status after failed explicit discovery", async () => {
  const native = client(connected);
  native.status = vi.fn().mockResolvedValueOnce(connected).mockResolvedValue({ ...connected, state: "refresh_required", models: [] });
  native.refresh = vi.fn().mockRejectedValue(new Error("DiscoveryUnavailable"));
  const changed = vi.fn(); setup(native, changed);
  fireEvent.click(await screen.findByRole("button", { name: "Check Claude connection" }));
  await screen.findByText("Check connection");
  expect(screen.queryByText("Connected")).toBeNull();
  expect(screen.queryByText(/Available for chats/)).toBeNull();
  expect(native.status).toHaveBeenCalledTimes(2);
  expect(changed).toHaveBeenCalledOnce();
});

it("does not retain runnable readiness when status reconciliation also fails", async () => {
  const native = client(connected);
  native.status = vi.fn().mockResolvedValueOnce(connected).mockRejectedValue(new Error("StatusUnavailable"));
  native.refresh = vi.fn().mockRejectedValue(new Error("DiscoveryUnavailable"));
  const changed = vi.fn(); setup(native, changed);
  fireEvent.click(await screen.findByRole("button", { name: "Check Claude connection" }));
  await screen.findByText("Unavailable");
  expect(screen.queryByText(/Available for chats/)).toBeNull();
  expect(changed).toHaveBeenCalledOnce();
});

// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IntegrationsSettingsSection, useIntegrations } from "../../desktop/src/renderer/src/features/integrations";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import type { ApiClient } from "../../desktop/src/renderer/src/lib/api";

const account = { id: "7d3f6f1e-2b3c-4a5d-8e9f-0a1b2c3d4e5f", service: "gmail", account_label: "Work", account_email: "work@example.invalid", status: "active", connected_at: "2026-10-01T10:00:00.000Z" };
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false; });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: false })) });
  window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
  useIntegrations.setState(useIntegrations.getInitialState(), true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it.each([
  ["poll", "timestamp"], ["poll", "status"], ["manual", "timestamp"], ["manual", "status"],
] as const)("completes same-ID Gmail reauthorization via %s after %s recovery", async (mode, recovery) => {
  const before = recovery === "status" ? { ...account, status: "expired" } : account;
  const after = recovery === "timestamp" ? { ...account, connected_at: "2026-10-08T10:00:00.000Z" } : account;
  const api = {
    get: vi.fn(async (path: string) => path.endsWith("/available") ? [{ id: "gmail", name: "Gmail", category: "google", actions: {} }]
      : path.endsWith("/connection-options") ? { methods: ["matrix", "pipedream"], defaultMethod: "matrix" } : [before]),
    post: vi.fn(async (path: string) => path.endsWith("/connect") ? { url: "https://app.matrix-os.com/auth/gmail?state=opaque", service: "gmail" }
      : { synced: 0, services: [after] }),
  } as unknown as ApiClient;
  useConnection.setState({ status: "signed-in", handle: "operator", api: api as never });
  render(<IntegrationsSettingsSection pollIntervals={mode === "poll" ? [10, 10] : [60_000]} />);
  fireEvent.click(await screen.findByTestId("integration-connect-gmail"));
  fireEvent.click(await screen.findByRole("button", { name: "Connect with Matrix (internal preview)" }));
  await waitFor(() => expect(window.operator.invoke).toHaveBeenCalledOnce());
  if (mode === "manual") fireEvent.click(screen.getByRole("button", { name: /I've connected/i }));
  await waitFor(() => expect(screen.queryByText(/waiting for|Still waiting|Not connected yet/i)).toBeNull());
  expect(api.post).toHaveBeenCalledWith("/api/integrations/sync", {});
});

it.each(['pending', 'expired', 'unavailable'])('never substitutes account availability for a %s receipt', async receiptState => {
  const attemptId = '123e4567-e89b-42d3-a456-426614174000';
  const get = vi.fn(async (path: string) => path.endsWith('/available') ? [{ id: 'gmail', name: 'Gmail', category: 'google' }]
    : path.endsWith('/connection-options') ? { methods: ['pipedream'], defaultMethod: 'pipedream' }
    : path.includes('/attempts/') ? receiptState === 'unavailable' ? { error: 'unavailable' } : { status: receiptState } : [account]);
  const post = vi.fn(async (path: string) => path.endsWith('/connect') ? { url: 'https://pipedream.com/connect', service: 'gmail', attemptId }
    : { synced: 1, services: [{ ...account, connected_at: '2099-01-01' }] });
  const api = { get, post } as unknown as ApiClient;
  useConnection.setState({ status: 'signed-in', handle: 'operator', api: api as never });
  render(<IntegrationsSettingsSection pollIntervals={[60_000]} />);
  fireEvent.click(await screen.findByTestId('integration-connect-gmail'));
  await waitFor(() => expect(window.operator.invoke).toHaveBeenCalledOnce());
  fireEvent.click(await screen.findByRole('button', { name: /I've connected/i }));
  await waitFor(() => expect(get).toHaveBeenCalledWith('/api/integrations/gmail/pipedream/attempts/' + attemptId));
  expect(post.mock.calls.every(([path]) => !path.endsWith('/sync'))).toBe(true);
});
it('completes the exact receipt account even when its active metadata is unchanged', async () => {
  const attemptId = '123e4567-e89b-42d3-a456-426614174000';
  const api = {
    get: vi.fn(async (path: string) => path.endsWith('/available') ? [{ id: 'gmail', name: 'Gmail', category: 'google' }]
      : path.endsWith('/connection-options') ? { methods: ['pipedream'], defaultMethod: 'pipedream' }
      : path.includes('/attempts/') ? { status: 'succeeded', accountId: account.id } : [account]),
    post: vi.fn(async () => ({ url: 'https://pipedream.com/connect', service: 'gmail', attemptId })),
  } as unknown as ApiClient;
  useConnection.setState({ status: 'signed-in', handle: 'operator', api: api as never });
  render(<IntegrationsSettingsSection pollIntervals={[10]} />);
  fireEvent.click(await screen.findByTestId('integration-connect-gmail'));
  await waitFor(() => expect(window.operator.invoke).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.queryByRole('button', { name: /I've connected/i })).toBeNull());
});
it('keeps a terminal poll success when an older manual check fails later', async () => {
  const attemptId = '123e4567-e89b-42d3-a456-426614174000';
  let failManual!: (error: Error) => void;
  const manual = new Promise<unknown>((_resolve, reject) => { failManual = reject; });
  let receipts = 0;
  const api = {
    get: vi.fn(async (path: string) => path.endsWith('/available') ? [{ id: 'gmail', name: 'Gmail', category: 'google' }]
      : path.endsWith('/connection-options') ? { methods: ['pipedream'], defaultMethod: 'pipedream' }
      : path.includes('/attempts/') ? ++receipts === 1 ? manual : { status: 'succeeded', accountId: account.id } : [account]),
    post: vi.fn(async () => ({ url: 'https://pipedream.com/connect', service: 'gmail', attemptId })),
  } as unknown as ApiClient;
  useConnection.setState({ status: 'signed-in', handle: 'operator', api: api as never });
  render(<IntegrationsSettingsSection pollIntervals={[100]} />);
  fireEvent.click(await screen.findByTestId('integration-connect-gmail'));
  await waitFor(() => expect(window.operator.invoke).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('button', { name: /I've connected/i }));
  await waitFor(() => expect(receipts).toBe(2));
  await waitFor(() => expect(screen.queryByRole('button', { name: /I've connected/i })).toBeNull());
  await act(async () => failManual(new Error('Delayed manual failure')));
  expect(useIntegrations.getState().errorMessage).toBeNull();
});
it('keeps terminal failure when an older receipt inventory refresh resolves later', async () => {
  const attemptId = '123e4567-e89b-42d3-a456-426614174000';
  let failManual!: (error: Error) => void; let finishInventory!: (rows: unknown) => void;
  const manual = new Promise<unknown>((_resolve, reject) => { failManual = reject; });
  const inventory = new Promise(resolve => { finishInventory = resolve; });
  let receipts = 0; let inventories = 0;
  const api = {
    get: vi.fn(async (path: string) => path.endsWith('/available') ? [{ id: 'gmail', name: 'Gmail', category: 'google' }]
      : path.endsWith('/connection-options') ? { methods: ['pipedream'], defaultMethod: 'pipedream' }
      : path.includes('/attempts/') ? ++receipts === 1 ? manual : { status: 'succeeded', accountId: account.id }
      : ++inventories === 1 ? [account] : inventory),
    post: vi.fn(async () => ({ url: 'https://pipedream.com/connect', service: 'gmail', attemptId })),
  } as unknown as ApiClient;
  useConnection.setState({ status: 'signed-in', handle: 'operator', api: api as never });
  render(<IntegrationsSettingsSection pollIntervals={[100]} />);
  fireEvent.click(await screen.findByTestId('integration-connect-gmail'));
  await waitFor(() => expect(window.operator.invoke).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('button', { name: /I've connected/i }));
  await waitFor(() => expect(inventories).toBe(2));
  expect(useIntegrations.getState().status).toBe('loading');
  await act(async () => failManual(new Error('Delayed terminal failure')));
  const terminalError = useIntegrations.getState().errorMessage;
  expect(terminalError).toBeTruthy();
  expect(useIntegrations.getState().status).toBe('ready');
  await act(async () => { finishInventory([{ ...account, account_label: 'Stale inventory' }]); });
  expect(useIntegrations.getState().errorMessage).toBe(terminalError);
  expect(useIntegrations.getState().status).toBe('ready');
  expect(useIntegrations.getState().connections[0]?.accountLabel).toBe('Work');
});

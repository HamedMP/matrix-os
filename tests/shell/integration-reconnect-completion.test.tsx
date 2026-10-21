// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/gateway", () => ({ getGatewayUrl: () => "https://gateway.test", getGatewayWs: () => "wss://gateway.test/ws" }));
vi.mock("@/lib/websocket-auth", () => ({ buildAuthenticatedWebSocketUrl: () => new Promise(() => {}) }));
import { IntegrationsSection } from "../../shell/src/components/settings/sections/IntegrationsSection.js";

const account = { id: "work", service: "gmail", account_label: "Work", account_email: "work@example.invalid", status: "active", connected_at: "2026-10-01T10:00:00.000Z" };
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false; });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it.each(["timestamp", "status"])("completes same-ID Gmail reauthorization after %s recovery", async recovery => {
  const before = recovery === "status" ? { ...account, status: "expired" } : account;
  const after = recovery === "timestamp" ? { ...account, connected_at: "2026-10-08T10:00:00.000Z" } : account;
  let poll!: () => Promise<void>;
  const setInterval = globalThis.setInterval;
  vi.spyOn(globalThis, "setInterval").mockImplementation((callback, delay, ...args) => {
    if (delay === 2_000) poll = callback as () => Promise<void>;
    return setInterval(callback, delay, ...args);
  });
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.endsWith("/available") ? [{ id: "gmail", name: "Gmail", category: "google", authType: "oauth" }]
      : url.endsWith("/connection-options") ? { methods: ["matrix", "pipedream"], defaultMethod: "matrix" }
      : url.endsWith("/connect") ? { url: "https://app.matrix-os.com/auth/gmail?state=opaque" }
      : url.endsWith("/sync") ? { synced: 0, services: [after] } : [before];
    return { ok: true, status: 200, json: async () => body };
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "open").mockReturnValue({ location: { href: "about:blank" }, close: vi.fn() } as unknown as Window);
  render(<IntegrationsSection />);
  fireEvent.click(await screen.findByRole("button", { name: "Add another Gmail account" }));
  fireEvent.click(await screen.findByRole("button", { name: "Connect with Matrix (internal preview)" }));
  await waitFor(() => expect(poll).toBeTypeOf("function"));
  expect((screen.getByRole("button", { name: "Add another Gmail account" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => poll());
  expect((screen.getByRole("button", { name: "Add another Gmail account" }) as HTMLButtonElement).disabled).toBe(false);
});
it.each(['pending', 'succeeded', 'expired', 'unavailable'])('uses exact receipt status %s instead of inventory completion', async receiptState => {
  const attemptId = '123e4567-e89b-42d3-a456-426614174000';
  const current = { ...account, id: attemptId };
  let poll!: () => Promise<void>;
  const interval = globalThis.setInterval;
  vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, delay, ...args) => {
    if (delay === 2_000) poll = callback as () => Promise<void>;
    return interval(callback, delay, ...args);
  });
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.endsWith('/available') ? [{ id: 'gmail', name: 'Gmail', category: 'google', authType: 'oauth' }]
      : url.endsWith('/connection-options') ? { methods: ['pipedream'], defaultMethod: 'pipedream' }
      : url.endsWith('/connect') ? { url: 'https://pipedream.com/connect', service: 'gmail', attemptId }
      : url.includes('/attempts/') ? receiptState === 'unavailable' ? { error: 'unavailable' } : { status: receiptState, accountId: attemptId }
      : url.endsWith('/sync') ? { services: [{ ...current, connected_at: '2099-01-01' }] } : [current];
    return { ok: receiptState !== 'unavailable' || !url.includes('/attempts/'), status: 200, json: async () => body };
  });
  vi.stubGlobal('fetch', fetcher);
  vi.spyOn(window, 'open').mockReturnValue({ location: { href: 'about:blank' }, close: vi.fn() } as unknown as Window);
  render(<IntegrationsSection />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add another Gmail account' }));
  await waitFor(() => expect(poll).toBeTypeOf('function'));
  await act(async () => poll());
  expect(fetcher).toHaveBeenCalledWith('https://gateway.test/api/integrations/gmail/pipedream/attempts/' + attemptId, expect.anything());
  expect(fetcher.mock.calls.every(([url]) => !String(url).endsWith('/sync'))).toBe(true);
  expect((screen.getByRole('button', { name: 'Add another Gmail account' }) as HTMLButtonElement).disabled).toBe(receiptState === 'pending');
  if (receiptState === 'expired' || receiptState === 'unavailable') expect(screen.getByText('Could not confirm connection. Try connecting again.')).toBeTruthy();
});

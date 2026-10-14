// @vitest-environment jsdom
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store";
import { createProviderTerminalLoginHandoff } from "../../packages/gateway/src/ai-providers/provider-terminal-login-handoff";
import { createProviderSettingsRoutes } from "../../packages/gateway/src/ai-providers/provider-settings-routes";
import { createManagedCreditOwnerAuthorization } from "../../packages/gateway/src/ai-providers/provider-managed-credit-authorization";
import { createApiClient } from "../../desktop/src/renderer/src/lib/api";
import { createDesktopProviderSettingsTransport } from "../../desktop/src/renderer/src/features/settings/provider-settings-desktop-adapter";
import { useProviderSettingsController } from "../../packages/ui/src/agents-providers/provider-settings-controller";
import { gatewayChatAvailableMicrousd } from "../../packages/ui/src/agents-providers/utils";
import { PROVIDER_SETTINGS_NOW, providerSettingsCanonicalFixture, providerSettingsFundingSummaryFixture } from "../gateway/provider-settings-test-support";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "credit-runtime-handoff-"));
  vi.useFakeTimers(); vi.setSystemTime(PROVIDER_SETTINGS_NOW);
});
afterEach(async () => { cleanup(); vi.useRealTimers(); await rm(home, { recursive: true, force: true }); });

it("keeps visible native Settings credit fresh beyond six minutes through the production login facade", async () => {
  const discovery = vi.fn(async () => providerSettingsCanonicalFixture());
  const funding = vi.fn(async () => {
    const value = providerSettingsFundingSummaryFixture();
    const asOf = new Date().toISOString();
    Object.assign(value.funding, { asOf, monthlyBudgetMicrousd: 6_260_000, settledThisMonthMicrousd: 690_000,
      promotionalBalanceMicrousd: 4_980_000, creditBalanceMicrousd: 4_980_000,
      remainingBalanceMicrousd: 4_980_000, remainingBudgetMicrousd: 5_570_000 });
    Object.assign(value.policy, { checkedAt: asOf, staleAfter: new Date(Date.now() + 60_000).toISOString(), monthlyBudgetMicrousd: 6_260_000 });
    return { ...value, chatAvailability: { contractVersion: 1 as const, asOf,
      eligibleBalanceMicrousd: 4_980_000, availableBalanceMicrousd: 4_980_000 } };
  });
  const store = new ProviderSettingsStore({ homePath: join(home, "home"), privateRootPath: join(home, "private"),
    providerSnapshotReader: { getSnapshot: discovery }, fundingSummaryReader: { getFundingSummary: funding }, now: () => new Date() });
  const terminal = vi.fn();
  const facade = createProviderTerminalLoginHandoff(store, terminal);
  const principal = () => ({ userId: "fixture-owner" });
  const app = new Hono();
  app.route("/api/ai", createProviderSettingsRoutes({ store: facade, getPrincipal: principal,
    canReadManagedCredit: createManagedCreditOwnerAuthorization("fixture-owner", principal) }));
  const creditStatuses: number[] = [];
  let pendingCredit = 0;
  const api = createApiClient({ baseUrl: "http://fixture.invalid", getRuntimeSlot: () => "primary",
    fetchFn: async (url, init) => {
      const credit = new URL(url).pathname.endsWith("/managed-credit");
      if (credit) pendingCredit++;
      try {
        const response = await app.request(url, init);
        if (credit) creditStatuses.push(response.status);
        return response;
      } finally { if (credit) pendingCredit--; }
    } });
  const transport = createDesktopProviderSettingsTransport(api);
  const view = renderHook(() => useProviderSettingsController({ identityKey: "fixture-owner/primary", transport,
    automaticCreditRefreshEnabled: true }));
  await act(async () => { await vi.waitFor(() => expect(view.result.current.snapshot).not.toBeNull()); });
  const original = view.result.current.snapshot!;
  const bytes = await readFile(store.configurationPath, "utf8");
  const discoveryCount = discovery.mock.calls.length;
  const fundingCount = funding.mock.calls.length;
  for (let index = 0; index < 9; index++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
      await vi.waitFor(() => expect(pendingCredit).toBe(0));
    });
  }
  const next = view.result.current.snapshot!;
  expect.soft(gatewayChatAvailableMicrousd(next.accessSources.find(source => source.id === "matrix_included")!)).toBe(4_980_000);
  expect(creditStatuses.length).toBeGreaterThan(0);
  expect.soft(creditStatuses).toEqual(Array(creditStatuses.length).fill(200));
  expect.soft(funding.mock.calls.length - fundingCount).toBe(creditStatuses.length);
  expect(next.refreshedAt).toBe(original.refreshedAt);
  expect(discovery).toHaveBeenCalledTimes(discoveryCount);
  expect(terminal).not.toHaveBeenCalled();
  expect(view.result.current.busy).toBe(false);
  expect(view.result.current.error).toBeNull();
  expect(await readFile(store.configurationPath, "utf8")).toBe(bytes);
});

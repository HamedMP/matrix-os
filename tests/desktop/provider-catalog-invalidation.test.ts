// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { desktopProviderIdentityKey } from "../../desktop/src/renderer/src/lib/provider-settings-identity";
import { desktopProviderCatalogCache, stopDesktopProviderCatalogCoordinator } from "../../desktop/src/renderer/src/features/chat/provider-catalog-coordinator";
import { invalidateDesktopProviderCatalog } from "../../desktop/src/renderer/src/features/chat/provider-catalog-invalidation";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";
import { disconnectedSnapshot } from "../ui/chat-provider-settings-fixture";

const catalog = createCanonicalProviderCatalogFixture();
const snapshot = disconnectedSnapshot();
afterEach(() => { stopDesktopProviderCatalogCoordinator(); useConnection.setState(useConnection.getInitialState(), true); vi.restoreAllMocks(); });

it("only suspends the known harness kind for an accepted enablement change", async () => {
  const instance = catalog.instances[0]!;
  const harness = snapshot.harnesses[0]!;
  const driverKind = harness.harness === "claude" ? "claude_code" : harness.harness;
  const projected = { ...catalog, drivers: [{ ...catalog.drivers[0]!, kind: driverKind }], instances: [{ ...instance, driverKind }] };
  const identity = desktopProviderIdentityKey(useConnection.getState());
  desktopProviderCatalogCache.observe({ identityKey: identity, generation: 0, api: { get: vi.fn().mockResolvedValue(projected) } });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  invalidateDesktopProviderCatalog(identity, { type: "set_harness_enabled", harnessInstanceId: harness.id, enabled: false }, snapshot);
  expect(useConnection.getState().providerCatalogAffectedInstanceIds).toEqual([instance.id]);
});
it("falls back to conservative suspension for unknown targets, account changes and refresh", () => {
  const identity = desktopProviderIdentityKey(useConnection.getState());
  invalidateDesktopProviderCatalog(identity, { type: "set_harness_enabled", harnessInstanceId: "missing", enabled: false }, snapshot);
  expect(useConnection.getState().providerCatalogAffectedInstanceIds).toBeNull();
  invalidateDesktopProviderCatalog(identity, { type: "logout_account", accountId: "account" }, snapshot);
  expect(useConnection.getState().providerCatalogAffectedInstanceIds).toBeNull();
  invalidateDesktopProviderCatalog(identity);
  expect(useConnection.getState().providerCatalogAffectedInstanceIds).toBeNull();
});
it("cannot invalidate another authenticated runtime", () => {
  invalidateDesktopProviderCatalog("incompatible_identity");
  expect(useConnection.getState().providerCatalogGeneration).toBe(0);
});

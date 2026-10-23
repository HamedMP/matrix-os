import { expect, it, vi } from "vitest";
import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { createCodexNativeConnectionRecovery, codexNativeConnectionNeedsRecovery } from "../../packages/gateway/src/ai-providers/codex-native-connection-recovery.js";
import { bindNativeAccountMetadata, nativeAccountPrincipalFingerprint } from "../../packages/gateway/src/ai-providers/native-account-metadata-binding.js";
import { ProviderSettingsConfigurationSchema } from "../../packages/gateway/src/ai-providers/provider-settings-persistence.js";
import { ProviderSettingsStoreError } from "../../packages/gateway/src/ai-providers/provider-settings-errors.js";

function fixture() {
  const config = ProviderSettingsConfigurationSchema.parse({ schemaVersion: 1, revision: 1,
    harnesses: [{ id: "harness_codex", driverId: "codex", harness: "codex", displayName: "Codex", accentColor: null,
      enabled: true, selectedAccountId: "owner_codex", accessSourceId: "owner_openai_profile",
      route: { kind: "fixed", providerId: "openai", modelId: "gpt-test" } }],
    accountProfiles: [], gatewayPolicy: null, receipts: [] });
  const metadata = bindNativeAccountMetadata({ accountLabel: "owner@example.invalid", authMethod: "terminal",
    checkedAt: new Date().toISOString(), staleAfter: new Date(Date.now() + 30000).toISOString() }, async () => true, "private-fixture-principal");
  const snapshot = { revision: 2 } as ProviderSettingsSnapshot;
  return { config, metadata, snapshot };
}

it.each(["no-row", "ambiguous", "off", "wrong-driver", "wrong-account", "wrong-source", "wrong-provider", "configurable", "complete"])("refuses automatic repair for %s", mode => {
  const { config } = fixture(); const row = config.harnesses[0]!;
  if (mode === "no-row") config.harnesses = [];
  if (mode === "ambiguous") config.harnesses.push({ ...row, id: "other_codex" });
  if (mode === "off") row.enabled = false;
  if (mode === "wrong-driver") row.driverId = "other";
  if (mode === "wrong-account") row.selectedAccountId = "other";
  if (mode === "wrong-source") row.accessSourceId = "owner_openai_key";
  if (mode === "wrong-provider") row.route.providerId = "anthropic";
  if (mode === "configurable") row.route.kind = "configurable";
  if (mode === "complete") { row.nativeAccountGeneration = "a".repeat(64); row.nativeAccountConsentRevision = 1; }
  expect(codexNativeConnectionNeedsRecovery(config)).toBe(false);
});

it('finishes a partial binding only for the same privately bound account', async () => {
  const { config, metadata, snapshot } = fixture();
  config.harnesses[0]!.nativeAccountGeneration = nativeAccountPrincipalFingerprint(metadata)!;
  const complete = vi.fn(async (_input: { verifyNativeAccount(value: typeof metadata): Promise<boolean> }) => ({ snapshot }));
  const recover = createCodexNativeConnectionRecovery(complete);
  expect(await recover(config, metadata)).toBe(snapshot);
  const request = complete.mock.calls[0]![0];
  await expect(request.verifyNativeAccount(metadata)).resolves.toBe(true);
  const other = bindNativeAccountMetadata({ ...metadata }, async () => true, 'other-principal');
  await expect(request.verifyNativeAccount(other)).resolves.toBe(false);
  expect(await recover(config, other)).toBeNull();
  expect(await recover(config, { ...metadata })).toBeNull();
  expect(await recover(config, { ...metadata, authMethod: 'api_key' })).toBeNull();
});

it('coalesces the same revision and rejects a different revision until the repair drains', async () => {
  const { config, metadata, snapshot } = fixture();
  let release!: (value: { snapshot: ProviderSettingsSnapshot }) => void;
  const complete = vi.fn(() => new Promise<{ snapshot: ProviderSettingsSnapshot }>(resolve => { release = resolve; }));
  const recover = createCodexNativeConnectionRecovery(complete);
  const first = recover(config, metadata), second = recover(config, metadata);
  await expect(recover({ ...config, revision: 2 }, metadata)).rejects.toMatchObject({ code: 'revision_conflict' });
  expect(complete).toHaveBeenCalledTimes(1);
  release({ snapshot });
  expect(await first).toBe(snapshot); expect(await second).toBe(snapshot);
  const next = recover(config, metadata); // The completed promise was evicted.
  expect(complete).toHaveBeenCalledTimes(2);
  release({ snapshot }); await next;
});

it.each([new ProviderSettingsStoreError('revision_conflict', 409), new Error('private-error'), 'private-error'])(
  'clears a failed repair without leaking details (%s)', async error => {
    const { config, metadata, snapshot } = fixture();
    const complete = vi.fn().mockRejectedValueOnce(error).mockResolvedValue({ snapshot });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const recover = createCodexNativeConnectionRecovery(complete);
      await expect(recover(config, metadata)).rejects.toMatchObject({ code: error instanceof ProviderSettingsStoreError ? 'revision_conflict' : 'projection_unavailable' });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private-error');
      expect(await recover(config, metadata)).toBe(snapshot);
    } finally { warn.mockRestore(); }
  },
);

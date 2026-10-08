import { describe, expect, it } from "vitest";
import type { ProviderHarnessInstance, ProviderAccessSource } from "@matrix-os/contracts";
import { providerEnablementBlockReason } from "../../packages/ui/src/agents-providers/provider-enablement";

const agent = (patch: Partial<ProviderHarnessInstance> = {}) => ({ id: "hermes", harness: "hermes", enabled: false,
  installState: "installed", accessSourceId: null,
  route: { kind: "configurable", providerId: "anthropic", modelId: "claude-fable-5" }, ...patch }) as ProviderHarnessInstance;
const ownerSource = { id: "owner_key", kind: "provider_account", providerId: "anthropic", accountId: "owner",
  fundingKind: "owner_api_key" } as ProviderAccessSource;
describe("provider enablement prerequisites", () => {
  it("explains the current Hermes source:null rejection before advertising an actionable toggle", () => {
    expect(providerEnablementBlockReason(agent(), [])).toBe("Connect an account before enabling this agent.");
  });
  it("allows a configured owner route without inventing verified auth", () => {
    expect(providerEnablementBlockReason(agent({ accessSourceId: ownerSource.id }), [ownerSource])).toBeNull();
  });
  it("never blocks the owner's explicit Off even when runtime or source disappeared", () => {
    expect(providerEnablementBlockReason(agent({ enabled: true, installState: "missing" }), [])).toBeNull();
  });
  it("keeps installed fixed native harness enablement independent from login", () => {
    expect(providerEnablementBlockReason(agent({ harness: "codex", route: { kind: "fixed", providerId: "openai", modelId: "native" } }), [])).toBeNull();
  });
  it("requires installation before enabling and forbids Matrix relay credentials on Hermes", () => {
    expect(providerEnablementBlockReason(agent({ installState: "missing" }), [])).toBe("Install this agent before enabling it.");
    const relay = { ...ownerSource, id: "matrix", kind: "matrix_gateway", accountId: null, fundingKind: "matrix_included" } as ProviderAccessSource;
    expect(providerEnablementBlockReason(agent({ accessSourceId: relay.id }), [relay])).toBe("Connect an account before enabling this agent.");
  });
});

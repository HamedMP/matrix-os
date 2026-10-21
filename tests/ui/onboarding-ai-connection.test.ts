import { describe, expect, it } from "vitest";
import type { CanonicalProviderCatalog } from "../../packages/contracts/src/index.js";
import { createLegacyGlobalProviderCatalog } from "../../desktop/src/renderer/src/features/chat/canonical-composer-adapter";
import { onboardingAiDetail, onboardingConnectionLabels } from "../../packages/ui/src/onboarding-widget/host/catalog.js";

type Instance = CanonicalProviderCatalog["instances"][number];
const base = createLegacyGlobalProviderCatalog({ hasProject: false });
const hermes = base.instances.find((instance) => instance.id === "hermes_default")!;
function instance(id: string, driverKind: string, extra: Partial<Instance> = {}): Instance {
  return { ...hermes, id, driverKind, availability: "available",
    models: [{ ...hermes.models[0]!, id: "default", displayName: "Default · currently Claude Opus 5.5" }],
    defaultSelection: { instanceId: id, model: "default" }, ...extra } as Instance;
}
const catalogOf = (...instances: Instance[]): CanonicalProviderCatalog => ({ ...base, instances });

describe("onboarding AI connection details", () => {
  it("names the model and the connection Chat's picker shows for a connected provider", () => {
    const catalog = catalogOf(hermes, instance("claude_code_default", "claude_code", { connectionLabel: "Anthropic API key" }));
    expect(onboardingAiDetail(catalog, "claude")).toBe("Claude Opus 5.5 · Anthropic API key");
    expect(onboardingConnectionLabels(catalog)).toEqual({ claude: "Anthropic API key" });
  });

  it("follows the subscription label when Claude runs on the Claude plan", () => {
    const catalog = catalogOf(instance("claude_code_default", "claude_code", { connectionLabel: "Claude subscription" }));
    expect(onboardingAiDetail(catalog, "claude")).toBe("Claude Opus 5.5 · Claude subscription");
  });

  it("leaves Matrix AI and unavailable providers to the existing wording", () => {
    const catalog = catalogOf(hermes, instance("claude_code_default", "claude_code", { availability: "unavailable", connectionLabel: "Anthropic API key" }));
    expect(onboardingAiDetail(catalog, "matrix")).toBeNull();
    expect(onboardingAiDetail(catalog, "claude")).toBeNull();
    expect(onboardingConnectionLabels(catalog)).toEqual({});
  });
});

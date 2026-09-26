import { expect, it } from "vitest";
import { jevAgentSelection } from "../../packages/ui/src/chat-agents/jev-agent-template.js";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat.js";
function catalog() {
  const value = createCanonicalProviderCatalogFixture();
  value.instances.push({ ...value.instances[0]!, id: "hermes_default", driverKind: "hermes",
    models: ["openai:gpt-fixture", "anthropic:sonnet-fixture"].map(id => ({ ...value.instances[0]!.models[0]!, id })),
    defaultSelection: { instanceId: "hermes_default", model: "anthropic:sonnet-fixture" } });
  return value;
}
it("uses only the existing server-selected Hermes default, never the first model", () => {
  expect(jevAgentSelection(catalog())).toEqual({ instanceId: "hermes_default", model: "anthropic:sonnet-fixture" });
});
it.each(["missing-default", "unavailable", "missing-model", "wrong-instance", "duplicate"])("has no first-route fallback for %s", mode => {
  const value = catalog(); const instance = value.instances.at(-1)!;
  if (mode === "missing-default") delete instance.defaultSelection;
  if (mode === "unavailable") instance.availability = "setup_required";
  if (mode === "missing-model") instance.models = instance.models.slice(0, 1);
  if (mode === "wrong-instance") instance.defaultSelection = { instanceId: "other", model: "anthropic:sonnet-fixture" };
  if (mode === "duplicate") value.instances.push({ ...instance });
  expect(jevAgentSelection(value)).toBeNull();
});

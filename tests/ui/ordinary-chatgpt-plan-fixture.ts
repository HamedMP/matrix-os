import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat.js";
export const planId = "matrix_pi_chatgpt_plan";
export const planBinding = [{ id: "accountId", value: "account-a" }, { id: "grantRevision", value: "3" }];
export function ordinaryPlanCatalog() {
  const catalog = createCanonicalProviderCatalogFixture(), base = catalog.instances[0]!;
  catalog.drivers.push({ kind: "matrix_pi", displayName: "Matrix AI", adapterVersion: "1.0.0", capabilityClass: "system_agent" });
  catalog.instances.push({ ...base, id: planId, driverKind: "matrix_pi", displayName: "Codex · ChatGPT subscription", connectionLabel: "ChatGPT subscription",
    defaultSelection: { instanceId: planId, model: "gpt-owner", options: planBinding },
    options: planBinding.map(option => ({ id: option.id, label: option.id, kind: "enum" as const, placement: "advanced" as const,
      values: [{ value: option.value, label: option.value }], defaultValue: option.value })),
    supports: { ...base.supports, rootChat: true, resume: false, attachments: [], tools: [], resources: [], userInput: false, interactionModes: ["default"] }, models: [{ ...base.models[0]!, id: "gpt-owner", displayName: "Owner GPT" }] });
  return catalog;
}

import { ordinaryPlanCatalog } from "./ordinary-chatgpt-plan-fixture.js";
export const apiId = "matrix_pi_anthropic_api";
export const apiBinding = [{ id: "connectionRevision", value: "3" }, { id: "credentialGeneration", value: "e16625fe-cad7-4983-a9db-e808bbf104cc" }];
export function ordinaryApiCatalog() {
 const catalog = ordinaryPlanCatalog(), instance = catalog.instances[1]!;
 instance.id = apiId; instance.displayName = "Matrix AI · Anthropic API"; instance.connectionLabel = "Anthropic API";
 instance.models = [{ ...instance.models[0]!, id: "claude-owner", displayName: "Owner Claude" }];
 instance.defaultSelection = { instanceId: apiId, model: "claude-owner", options: apiBinding };
 instance.options = apiBinding.map(option => ({ id: option.id, label: option.id, kind: "enum", placement: "advanced", values: [{ value: option.value, label: "Current connection" }], defaultValue: option.value }));
 return catalog;
}

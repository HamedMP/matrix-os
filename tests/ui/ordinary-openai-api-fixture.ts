import { ordinaryApiCatalog } from "./ordinary-anthropic-api-fixture.js";
export const openAiApiId = "matrix_pi_openai_api";
export const openAiBinding = [{ id: "connectionRevision", value: "3" }, { id: "credentialGeneration", value: "e16625fe-cad7-4983-a9db-e808bbf104cc" }, { id: "api", value: "openai-completions" }];
export function ordinaryOpenAiCatalog(bot = false) {
 const catalog = ordinaryApiCatalog(), instance = catalog.instances[1]!;
 instance.id = bot ? "matrix_openai_api" : openAiApiId; instance.driverKind = bot ? "matrix_bot" : "matrix_pi";
 instance.displayName = "Matrix AI · OpenAI API"; instance.connectionLabel = "OpenAI API";
 instance.models = ["gpt-4.1", "gpt-4.1-mini"].map(id => ({ ...instance.models[0]!, id, displayName: id }));
 instance.defaultSelection = { instanceId: instance.id, model: "gpt-4.1", options: openAiBinding.map(o => o.id === "api" ? { ...o, value: "openai-responses" } : o) };
 instance.options = instance.defaultSelection.options!.map(option => ({ id: option.id, label: option.id, kind: "enum", placement: "advanced", values: option.id === "api" ? ["openai-completions", "openai-responses"].map(value => ({ value, label: value })) : [{ value: option.value, label: "Current connection" }], defaultValue: option.value }));
 instance.supports.rootChat = !bot; instance.supports.permissionModes = ["default", "supervised"];
 return catalog;
}

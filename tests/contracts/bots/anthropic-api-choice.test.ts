import { expect, it } from "vitest";
import { matrixAnthropicSelectionBinding, sameMatrixAnthropicSelectionBinding, isMatrixAnthropicChatRoute, isMatrixAnthropicBotRoute, isPiBotCoordinatorRoute, canonicalProviderModelRouteLabel, botModelRoutingLabel } from "@matrix-os/contracts";
import { createCanonicalProviderCatalogFixture } from "../fixtures/canonical-chat.js";
const options = [{ id: "connectionRevision", value: "3" }, { id: "credentialGeneration", value: "e16625fe-cad7-4983-a9db-e808bbf104cc" }];
it("binds API-paid choices to the exact source generation and revision", () => {
  expect(matrixAnthropicSelectionBinding(options)).toEqual({ connectionRevision: 3, credentialGeneration: options[1]!.value });
  expect(sameMatrixAnthropicSelectionBinding(options, [...options].reverse())).toBe(true);
  expect(matrixAnthropicSelectionBinding([...options, options[0]!])).toBeNull();
  for (const value of ["0", "-1", "1e3", "9007199254740992", true]) expect(matrixAnthropicSelectionBinding([{ ...options[0]!, value }, options[1]!])).toBeNull();
  expect(matrixAnthropicSelectionBinding([options[0]!, { ...options[1]!, value: "invalid" }])).toBeNull();
  expect(sameMatrixAnthropicSelectionBinding(options, [{ ...options[0]!, value: "4" }, options[1]!])).toBe(false);
});
it("keeps ordinary and recipe API-paid identities distinct and labels payment truthfully", () => {
  expect(isMatrixAnthropicChatRoute({ instanceId: "matrix_pi_anthropic_api", driverKind: "matrix_pi" })).toBe(true);
  expect(isMatrixAnthropicChatRoute({ instanceId: "matrix_pi_anthropic_api", driverKind: "pi" })).toBe(false);
  expect(isMatrixAnthropicBotRoute({ instanceId: "matrix_anthropic_api", driverKind: "matrix_bot" })).toBe(true);
  expect(isPiBotCoordinatorRoute({ instanceId: "matrix_anthropic_api", driverKind: "matrix_bot" })).toBe(true);
  const base = createCanonicalProviderCatalogFixture();
  const instance = { ...base.instances[0]!, id: "matrix_anthropic_api", driverKind: "matrix_bot" as const, models: [{ ...base.instances[0]!.models[0]!, id: "claude-test", displayName: "Claude Test" }], defaultSelection: { instanceId: "matrix_anthropic_api", model: "claude-test", options } };
  base.instances = [instance];
  expect(canonicalProviderModelRouteLabel(instance, "Claude Test")).toBe("Claude Test · Matrix AI · Anthropic API");
  expect(botModelRoutingLabel(instance.defaultSelection, base)).toBe("Anthropic API · Claude Test");
  expect(botModelRoutingLabel({ ...instance.defaultSelection, options: [{ ...options[0]!, value: "4" }, options[1]!] }, base)).toBe("Anthropic API · Claude Test · unavailable");
});

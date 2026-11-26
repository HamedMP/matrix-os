// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";
import { CanonicalProviderCatalogSchema } from "@matrix-os/contracts";
import { useChatProviderState } from "../../shell/src/components/chat-app-provider-setup";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it.each([false, true])("retains the bound Matrix identity and restricts the funding reason to a cataloged model (revoked=%s)", async (revoked) => {
  const catalog = createCanonicalProviderCatalogFixture();
  const base = catalog.instances[0]!;
  const model = "anthropic:claude-sonnet-5";
  catalog.drivers = [{ kind: "matrix_pi", displayName: "Pi", adapterVersion: "1.0.0", capabilityClass: "system_agent" }];
  catalog.instances = [{ ...base, id: "matrix_pi_default", driverKind: "matrix_pi", displayName: "Matrix AI", connectionLabel: "Matrix AI",
    connectionState: "credit_reserved", availability: "unavailable", defaultSelection: undefined,
    models: [{ ...base.models[0]!, id: model, displayName: "Claude Sonnet 5", availability: "unavailable" }] }];
  const observed = CanonicalProviderCatalogSchema.parse(catalog);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(observed)));
  const savedModel = revoked ? "anthropic:revoked-model" : model;
  const { result } = renderHook(() => useChatProviderState({ instanceId: "matrix_pi_default", model: savedModel }, "matrix_pi_default"));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.choices).toEqual([]);
  expect(result.current.selected).toBeNull();
  expect(result.current.displaySelection).toEqual({ instanceId: "matrix_pi_default", modelId: savedModel });
  expect(result.current.displayModelLabel).toBe(revoked ? savedModel : "Claude Sonnet 5");
  expect(result.current.selectionStatus).toBe(revoked ? "Unavailable" : "Credit reserved");
  expect(result.current.activeInstance?.id).toBe("matrix_pi_default");
});

it("retains a retired model on its bound Chat until the user chooses a replacement", async () => {
  const catalog = createCanonicalProviderCatalogFixture();
  const base = catalog.instances[0]!;
  const instanceId = "matrix_pi_default";
  const retired = "@cf/zai-org/glm-5.3-flash";
  const replacement = "@cf/zai-org/glm-5.3";
  catalog.drivers = [{ kind: "matrix_pi", displayName: "Pi", adapterVersion: "1.0.0", capabilityClass: "system_agent" }];
  catalog.instances = [{ ...base, id: instanceId, driverKind: "matrix_pi", displayName: "Matrix AI", connectionLabel: "Matrix AI",
    connectionState: "ready", availability: "available", defaultSelection: { instanceId, model: replacement },
    models: [{ ...base.models[0]!, id: replacement, displayName: "GLM 5.3", availability: "available" }] }];
  const observed = CanonicalProviderCatalogSchema.parse(catalog);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(observed)));
  const { result } = renderHook(() => useChatProviderState({ instanceId, model: retired }, instanceId));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.displaySelection).toEqual({ instanceId, modelId: retired });
  expect(result.current.displayModelLabel).toBe(retired);
  expect(result.current.selectionStatus).toBe("Unavailable");
  expect(result.current.selectionAvailable).toBe(false);
  expect(result.current.selected).toBeNull();
  expect(result.current.choices.map(choice => choice.modelId)).toEqual([replacement]);
  act(() => result.current.select(result.current.choices[0]!));
  expect(result.current.displaySelection).toEqual({ instanceId, modelId: replacement });
  expect(result.current.selectionAvailable).toBe(true);
});

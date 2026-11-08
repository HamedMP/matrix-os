// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CanonicalProviderCatalogSchema, RoutineFullAccessStatusSchema } from "@matrix-os/contracts";
import { useChatProviderState } from "../../shell/src/components/chat-app-provider-setup";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });
const status = RoutineFullAccessStatusSchema.parse({ revision: 3, eligibility: "eligible", origin: "browser_required", challenge: null,
  consent: { scopeId: `rcfull_${"a".repeat(32)}`, expiresAt: new Date(Date.now() + 300_000).toISOString(), policyRevision: 2,
    actions: ["read", "propose", "control"], target: { botId: "bot_fixture1", chatId: "chat_destination" } } });
function setup(revoke: () => Promise<typeof status>, initialMode = "full_access") {
  const catalog = createCanonicalProviderCatalogFixture();
  catalog.drivers[0]!.kind = "claude_code"; catalog.instances[0]!.driverKind = "claude_code";
  catalog.instances[0]!.options.push({ id: "effort", label: "Effort", kind: "enum", placement: "composer", defaultValue: "low",
    values: [{ value: "low", label: "Low" }, { value: "high", label: "High" }] });
  CanonicalProviderCatalogSchema.parse(catalog);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(catalog)));
  const client = { read: vi.fn(async () => status), revoke: vi.fn(revoke), challenge: vi.fn(async () => status), decide: vi.fn() };
  const selection = { instanceId: "codex_fixture", model: "gpt-5.6-sol" };
  const context = { chatId: "chat_one", scopeKey: "owner-session-computer", executionControls: { chatId: "chat_one", runId: "run_one", selection,
    interactionMode: "default", permissionMode: initialMode }, routineFullAccessClient: client, allowRoutineScope: true };
  const hook = renderHook(executionControls => useChatProviderState(selection, selection.instanceId, { ...context, executionControls }),
    { initialProps: context.executionControls });
  return { hook, client, executionControls: context.executionControls };
}
it("revokes the server scope before the existing permission picker reports a downgrade", async () => {
  let release!: (value: typeof status) => void;
  const pending = new Promise<typeof status>(resolve => { release = resolve; });
  const { hook, client } = setup(() => pending);
  await waitFor(() => expect(hook.result.current.selected?.permissionMode).toBe("full_access"));
  act(() => hook.result.current.selectPermissionMode("supervised"));
  await waitFor(() => expect(client.revoke).toHaveBeenCalledTimes(1));
  expect(hook.result.current.selected?.permissionMode).toBe("full_access");
  await act(async () => { release({ ...status, revision: 4, consent: null }); await pending; });
  await waitFor(() => expect(hook.result.current.selected?.permissionMode).toBe("supervised"));
});
it.each(["separate render", "same batch"])("preserves an effort change made during interaction-mode revocation (%s)", async timing => {
  const revocation = Promise.withResolvers<typeof status>();
  const { hook, client } = setup(() => revocation.promise);
  const low = [{ id: "effort", value: "low" }], high = [{ id: "effort", value: "high" }];
  await waitFor(() => expect(hook.result.current.selected?.selectedOptions).toEqual(low));

  act(() => hook.result.current.selectInteractionMode("plan"));
  await waitFor(() => expect(client.revoke).toHaveBeenCalledOnce());
  expect(hook.result.current.selected?.interactionMode).toBe("default");

  const selectHigh = () => hook.result.current.selectOption("effort", "high");
  if (timing === "separate render") {
    act(selectHigh);
    expect(hook.result.current.selected?.selectedOptions).toEqual(high);
    expect(hook.result.current.selected?.interactionMode).toBe("default");
  }
  await act(async () => {
    if (timing === "same batch") selectHigh();
    revocation.resolve({ ...status, revision: 4, consent: null });
    await revocation.promise;
  });
  expect(hook.result.current.selected).toMatchObject({ interactionMode: "plan", permissionMode: "full_access", selectedOptions: high });
});

it("does not overwrite the newer run's selection when an earlier mode change finishes revoking", async () => {
  const revocation = Promise.withResolvers<typeof status>();
  const { hook, client, executionControls } = setup(() => revocation.promise);
  await waitFor(() => expect(hook.result.current.selected?.permissionMode).toBe("full_access"));
  act(() => hook.result.current.selectInteractionMode("plan"));
  await waitFor(() => expect(client.revoke).toHaveBeenCalledOnce());

  hook.rerender({ ...executionControls, runId: "run_two" });
  act(() => hook.result.current.selectOption("effort", "high"));
  expect(hook.result.current.selected?.selectedOptions).toEqual([{ id: "effort", value: "high" }]);
  await act(async () => {
    revocation.resolve({ ...status, revision: 4, consent: null });
    await revocation.promise;
  });
  expect(hook.result.current.selected).toMatchObject({
    interactionMode: "default", selectedOptions: [{ id: "effort", value: "high" }],
  });
});

it("retains Full Access when revocation fails instead of showing a completed downgrade", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { hook, client } = setup(async () => { throw new Error("Fixture failed revoke"); });
  await waitFor(() => expect(hook.result.current.selected?.permissionMode).toBe("full_access"));
  act(() => hook.result.current.selectPermissionMode("supervised"));
  await waitFor(() => expect(client.revoke).toHaveBeenCalledTimes(1));
  expect(hook.result.current.selected?.permissionMode).toBe("full_access");
});

function providerSwitchSetup(defaultMode: "full_access" | "supervised", revoke: () => Promise<typeof status>) {
  const catalog = createCanonicalProviderCatalogFixture(), other = catalog.instances[0]!;
  const claude = structuredClone(other); claude.id = "claude_fixture"; claude.driverKind = "claude_code";
  claude.defaultSelection = { instanceId: claude.id, model: claude.models[0]!.id };
  claude.supports.permissionModes = ["full_access", "supervised"];
  other.supports.permissionModes = defaultMode === "full_access" ? ["full_access", "supervised"] : ["supervised", "full_access"];
  catalog.drivers.push({ ...catalog.drivers[0]!, kind: "claude_code" }); catalog.instances.unshift(claude);
  CanonicalProviderCatalogSchema.parse(catalog);
  localStorage.setItem("matrix:canonical-chat-provider-selection", JSON.stringify({ key: "claude_fixture:gpt-5.6-sol", interactionMode: "default", permissionMode: "full_access" }));
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(catalog)));
  const client = { read: vi.fn(async () => status), revoke: vi.fn(revoke), challenge: vi.fn(async () => status), decide: vi.fn() };
  const hook = renderHook(() => useChatProviderState(undefined, undefined, { chatId: "chat_one", scopeKey: "owner-session-computer", routineFullAccessClient: client, allowRoutineScope: true }));
  return { hook, client };
}
it("revokes Claude Full Access before switching to non-Claude Full Access, then revokes before Supervised", async () => {
  let release!: (value: typeof status) => void;
  const { hook, client } = providerSwitchSetup("full_access", () => new Promise(resolve => { release = resolve; }));
  await waitFor(() => expect(hook.result.current.selected?.instanceId).toBe("claude_fixture"));
  act(() => hook.result.current.select(hook.result.current.choices.find(choice => choice.driverKind === "codex")!));
  await waitFor(() => expect(client.revoke).toHaveBeenCalledTimes(1));
  expect(hook.result.current.selected?.instanceId).toBe("claude_fixture");
  await act(async () => { release({ ...status, revision: 4, consent: null }); });
  await waitFor(() => expect(hook.result.current.selected?.driverKind).toBe("codex"));
  expect(hook.result.current.routineAccess.visible).toBe(false);
  act(() => hook.result.current.selectPermissionMode("supervised"));
  await waitFor(() => expect(client.revoke).toHaveBeenCalledTimes(2));
  expect(hook.result.current.selected?.permissionMode).toBe("full_access");
  await act(async () => { release({ ...status, revision: 5, consent: null }); });
  await waitFor(() => expect(hook.result.current.selected?.permissionMode).toBe("supervised"));
});
it("defers an implicit provider-default downgrade until current Chat scope revocation is confirmed", async () => {
  let release!: (value: typeof status) => void;
  const { hook, client } = providerSwitchSetup("supervised", () => new Promise(resolve => { release = resolve; }));
  await waitFor(() => expect(hook.result.current.selected?.instanceId).toBe("claude_fixture"));
  act(() => hook.result.current.select(hook.result.current.choices.find(choice => choice.driverKind === "codex")!));
  expect(hook.result.current.selected?.instanceId).toBe("claude_fixture");
  await waitFor(() => expect(client.revoke).toHaveBeenCalledTimes(1));
  await act(async () => { release({ ...status, revision: 4, consent: null }); });
  await waitFor(() => expect(hook.result.current.selected?.permissionMode).toBe("supervised"));
});
it("keeps the qualified default interaction when revocation fails on a change to plan mode", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { hook, client } = providerSwitchSetup("supervised", async () => { throw new Error("Unknown revoke result"); });
  await waitFor(() => expect(hook.result.current.selected?.instanceId).toBe("claude_fixture"));
  act(() => hook.result.current.selectInteractionMode("plan"));
  await waitFor(() => expect(client.revoke).toHaveBeenCalledTimes(1));
  expect(hook.result.current.selected?.interactionMode).toBe("default");
  expect(hook.result.current.routineAccess.error).toBeTruthy();
});

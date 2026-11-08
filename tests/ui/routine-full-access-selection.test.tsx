// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RoutineFullAccessStatusSchema } from "@matrix-os/contracts";
import { routineFullAccessChatPresentationEligible } from "../../packages/ui/src/routine-action/full-access-presentation";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { useRoutineFullAccessSelection } from "../../packages/ui/src/routine-action/use-routine-full-access-selection";
const view = RoutineFullAccessStatusSchema.parse({ revision: 1, eligibility: "eligible", origin: "browser_required", challenge: null, consent: {
  scopeId: `rcfull_${"a".repeat(32)}`, expiresAt: new Date(Date.now() + 300_000).toISOString(), policyRevision: 0,
  actions: ["read", "propose", "control"], target: { botId: "bot_fixture1", chatId: "chat_destination" } } });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it.each(["non-Claude", "plan", "implicit Supervised"])("guards the native complete selection before committing %s", async condition => {
  let release!: (value: typeof view) => void;
  const client = { read: vi.fn(async () => view), revoke: vi.fn(() => new Promise<typeof view>(resolve => { release = resolve; })), challenge: vi.fn(), decide: vi.fn() };
  const onChange = vi.fn(), selection = { instanceId: "claude", permissionMode: "full_access", interactionMode: "default", model: "model", options: [{ id: "effort", value: "high" }] };
  const next = { ...selection, ...(condition === "non-Claude" ? { instanceId: "codex" } : condition === "plan" ? { interactionMode: "plan" } : { permissionMode: "supervised" }) };
  const mounted = renderHook(() => useRoutineFullAccessSelection({ context: { client, chatId: "chat_one", identity: "owner", enabled: true, browserOrigin: false }, selection, onChange,
    isQualified: (candidate: typeof selection) => candidate.instanceId === "claude" && candidate.permissionMode === "full_access" && candidate.interactionMode === "default" }));
  await waitFor(() => expect(mounted.result.current.controller.consent).not.toBeNull());
  act(() => mounted.result.current.onChange(next));
  await waitFor(() => expect(client.revoke).toHaveBeenCalledTimes(1));
  expect(onChange).not.toHaveBeenCalled();
  await act(async () => { release({ ...view, revision: 2, consent: null }); });
  await waitFor(() => expect(onChange).toHaveBeenCalledWith(next));
  expect(client.challenge).not.toHaveBeenCalled(); expect(client.decide).not.toHaveBeenCalled();
});

it("offers scope management only for a fresh personal active ordinary Chat projection", () => {
  const chat = createCanonicalChatFixture("idle").snapshot.chat;
  expect(routineFullAccessChatPresentationEligible({ chat, ordinary: true, fresh: true })).toBe(true);
  for (const patch of [{ ownerScope: { type: "organization" as const, ownerId: "org_fixture" } }, { lifecycle: "archived" as const },
    { collaboration: { mode: "shared" as const, membership: { role: "owner" as const, memberCount: 2 } } }])
    expect(routineFullAccessChatPresentationEligible({ chat: { ...chat, ...patch }, ordinary: true, fresh: true })).toBe(false);
  expect(routineFullAccessChatPresentationEligible({ chat, ordinary: false, fresh: true })).toBe(false);
  expect(routineFullAccessChatPresentationEligible({ chat, ordinary: true, fresh: false })).toBe(false);
  expect(routineFullAccessChatPresentationEligible({ ordinary: true, fresh: true })).toBe(false);
});

it("does not commit a deferred native downgrade after owner/Computer identity changes", async () => {
  let release!: (value: typeof view) => void;
  const client = { read: vi.fn(async () => view), revoke: vi.fn(() => new Promise<typeof view>(resolve => { release = resolve; })), challenge: vi.fn(), decide: vi.fn() };
  const onChange = vi.fn(), selection = { permissionMode: "full_access", instanceId: "claude", model: "model" };
  const mounted = renderHook(({ identity }) => useRoutineFullAccessSelection({ context: { client, chatId: "chat_one", identity, enabled: true, browserOrigin: false }, selection, onChange }),
    { initialProps: { identity: "owner-a:computer-a" } });
  await waitFor(() => expect(mounted.result.current.controller.consent).not.toBeNull());
  act(() => mounted.result.current.onChange({ ...selection, permissionMode: "supervised" }));
  await waitFor(() => expect(client.revoke).toHaveBeenCalledTimes(1));
  mounted.rerender({ identity: "owner-b:computer-b" });
  await act(async () => { release({ ...view, revision: 2, consent: null }); });
  expect(onChange).not.toHaveBeenCalled();
});
it("changes ordinary Chat permissions when the gateway confirms there is no routine scope", async () => {
  const client = { read: vi.fn(async () => ({ ...view, eligibility: "ineligible" as const, revision: 0, consent: null })),
    revoke: vi.fn(), challenge: vi.fn(), decide: vi.fn() };
  const onChange = vi.fn(), selection = { permissionMode: "full_access", instanceId: "codex", model: "model" };
  const next = { ...selection, permissionMode: "supervised" };
  const mounted = renderHook(() => useRoutineFullAccessSelection({ context: { client, chatId: "chat_one", identity: "owner",
    enabled: false, manage: true, browserOrigin: false }, selection, onChange }));
  await waitFor(() => expect(mounted.result.current.controller.status?.eligibility).toBe("ineligible"));
  act(() => mounted.result.current.onChange(next));
  await waitFor(() => expect(onChange).toHaveBeenCalledExactlyOnceWith(next));
  expect(client.revoke).not.toHaveBeenCalled();
});
it("keeps the selection when the gateway cannot confirm whether any scope exists", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const client = { read: vi.fn(async () => { throw new Error("Temporary outage"); }), revoke: vi.fn(), challenge: vi.fn(), decide: vi.fn() };
  const onChange = vi.fn(), selection = { permissionMode: "full_access", instanceId: "codex", model: "model" };
  const mounted = renderHook(() => useRoutineFullAccessSelection({ context: { client, chatId: "chat_one", identity: "owner",
    enabled: false, manage: true, browserOrigin: false }, selection, onChange }));
  await waitFor(() => expect(client.read).toHaveBeenCalledOnce());
  act(() => mounted.result.current.onChange({ ...selection, permissionMode: "supervised" }));
  await waitFor(() => expect(client.read).toHaveBeenCalledTimes(2));
  expect(onChange).not.toHaveBeenCalled();
  expect(client.revoke).not.toHaveBeenCalled();
});
it("exposes failed non-Claude revocation without offering a grant or reporting a downgrade", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const client = { read: vi.fn(async () => view), revoke: vi.fn(async () => { throw new Error("Uncertain result"); }), challenge: vi.fn(), decide: vi.fn() };
  const onChange = vi.fn(), selection = { permissionMode: "full_access", instanceId: "codex", model: "model" };
  const mounted = renderHook(() => useRoutineFullAccessSelection({ context: { client, chatId: "chat_one", identity: "owner", enabled: false, manage: true, browserOrigin: false }, selection, onChange }));
  await waitFor(() => expect(client.read).toHaveBeenCalled());
  act(() => mounted.result.current.onChange({ ...selection, permissionMode: "supervised" }));
  await waitFor(() => expect(mounted.result.current.controller.error).toBeTruthy());
  expect(mounted.result.current.controller.open).toBe(true); expect(mounted.result.current.controller.visible).toBe(true);
  expect(mounted.result.current.controller.grantEnabled).toBe(false); expect(onChange).not.toHaveBeenCalled();
  expect(client.challenge).not.toHaveBeenCalled(); expect(client.decide).not.toHaveBeenCalled();
});

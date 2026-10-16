import { expect, it, vi } from "vitest";
import { BotCreationSnapshotSchema, BotToolRequestSchema, CanonicalChatRunActivitySchema } from "@matrix-os/contracts";
import { createManagedPiOwnerTools } from "../../../packages/gateway/src/chat/managed-pi-owner-tools.js";
import { CanonicalProviderRunEventSchema } from "../../../packages/gateway/src/chat/provider-adapter.js";
import { activityPersistenceId } from "../../../packages/gateway/src/chat/activity-persistence.js";
import type { ManagedPiRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
const snapshot = BotCreationSnapshotSchema.parse({ sessionId: "creation_test", draftRevision: 3, seed: { kind: "scratch" }, draft: { name: "", description: "", instructions: "", selection: null } });
const binding = { kind: "managed_chat", ownerId: "owner_qa", chatId: "chat_qa", runId: "run_qa", runtimeHandle: `runtime_${"a".repeat(32)}`, executionGeneration: "1", capabilities: ["bot.creation.propose"], workspace: { kind: "chat_workspace" }, rootFingerprint: "a".repeat(64), botCreation: snapshot } as ManagedPiRuntimeBinding;
function setup() {
  const signal = new AbortController(); const events: unknown[] = [];
  const authority = vi.fn(async () => ({ permissionMode: "supervised", botCreation: snapshot }));
  const integrations = { inventory: vi.fn(), describe: vi.fn(), call: vi.fn() };
  const tools = createManagedPiOwnerTools({ authority, signalFor: () => signal.signal, integrations });
  return { signal, events, authority, integrations, tools };
}
const request = (toolCallId = "draft_call") => BotToolRequestSchema.parse({ toolCallId, capability: "bot.creation.propose", args: { patch: { name: "Planner", instructions: "Plan the owner's day." } } });
it("emits exactly one real validated proposal, preserving provenance through canonical persistence", async () => {
  const { tools, events, integrations } = setup();
  await tools.open(binding, event => events.push(event));
  expect(await tools.dispatch(binding, request(), new AbortController().signal)).toMatchObject({ ok: true });
  expect(events).toHaveLength(1);
  const event = CanonicalProviderRunEventSchema.parse(events[0]);
  expect(event).toMatchObject({ type: "bot.draft.proposed", sessionId: snapshot.sessionId, baseDraftRevision: 3, patch: { name: "Planner" } });
  const persisted = CanonicalChatRunActivitySchema.parse({ ...event, id: activityPersistenceId(binding.runId, event), chatId: binding.chatId, runId: binding.runId, occurredAt: "2026-10-14T00:00:00.000Z" });
  expect(activityPersistenceId(binding.runId, event)).toBe(persisted.id);
  await expect(tools.dispatch(binding, request("another_call"), new AbortController().signal)).rejects.toThrow();
  expect(events).toHaveLength(1); expect(integrations.call).not.toHaveBeenCalled();
  await tools.closeRun(binding.runId);
});
it("refuses ordinary runs, cross-scope/stale generations and changed snapshot authority", async () => {
  const { tools, events, authority, signal } = setup();
  await tools.open({ ...binding, botCreation: undefined, capabilities: ["integration.inventory"] }, event => events.push(event));
  await expect(tools.dispatch(binding, request(), signal.signal)).rejects.toThrow();
  await tools.closeRun(binding.runId);
  await tools.open(binding, event => events.push(event));
  for (const forged of [{ ...binding, ownerId: "other" }, { ...binding, executionGeneration: "2" }]) await expect(tools.dispatch(forged, request(), signal.signal)).rejects.toThrow();
  authority.mockResolvedValue({ permissionMode: "supervised", botCreation: { ...snapshot, draftRevision: 4 } });
  await expect(tools.dispatch(binding, request(), signal.signal)).rejects.toThrow();
  expect(events).toEqual([]); await tools.closeRun(binding.runId);
});
it("does not expose service calls even if a drafting binding is forged to include them", async () => {
  const { tools, events, integrations, signal } = setup();
  const forged = { ...binding, capabilities: [...binding.capabilities, "integration.inventory" as const] };
  await tools.open(forged, event => events.push(event));
  await expect(tools.dispatch(forged, BotToolRequestSchema.parse({ capability: "integration.inventory", toolCallId: "inventory", args: {} }), signal.signal)).rejects.toThrow();
  expect(integrations.inventory).not.toHaveBeenCalled(); await tools.closeRun(binding.runId);
});

import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { BotBrokerResponseSchema, BotToolRequestSchema, BotToolResultSchema, SharedBrowserActionResultSchema, type BotToolResult, type SharedBrowserAction } from "@matrix-os/contracts";
import { BotBrokerToolEffectUnknownError, createBotBrokerActions } from "../../../packages/gateway/src/bots/broker-actions.js";
import { createBotCheckpointsRepository } from "../../../packages/gateway/src/bots/repositories/checkpoints.js";
import { createBotSessionsRepository } from "../../../packages/gateway/src/bots/repositories/sessions.js";
import { BotRuntimeRegistry, type ManagedPiRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { createBotToolDispatcher } from "../../../packages/gateway/src/bots/tool-dispatcher.js";
import { createManagedPiCheckpointsRepository } from "../../../packages/gateway/src/chat/managed-pi-checkpoints.js";
import { createManagedPiOwnerTools } from "../../../packages/gateway/src/chat/managed-pi-owner-tools.js";
import { createManagedPiSessionsRepository } from "../../../packages/gateway/src/chat/managed-pi-sessions.js";
import { createSharedBrowserBroker, SharedBrowserError, type SharedBrowserDriver } from "../../../packages/gateway/src/shared-browser/broker.js";
import { NOW, createBotStateDatabase, insertChat } from "./bot-state-support.js";

const binding: ManagedPiRuntimeBinding = { kind: "managed_chat", ownerId: "owner_qa", chatId: "chat_qa", runId: "run_browser_qa", runtimeHandle: `runtime_${"a".repeat(32)}`,
  executionGeneration: "1", capabilities: ["browser.action"], workspace: { kind: "chat_workspace" }, rootFingerprint: "a".repeat(64),
  route: { api: "anthropic-messages", modelId: "claude-sonnet-5", input: ["text"], contextWindow: 200000, maxOutputTokens: 4096 },
  accessSourceId: "matrix_included", requestClass: "interactive",
};
function setup() {
  const controller = new AbortController();
  const authority = vi.fn(async () => ({ permissionMode: "full_access" }));
  const browser = { openRun: vi.fn(() => ({ token: "a".repeat(64), expiresAt: Date.now() + 60000 })),
    execute: vi.fn(async () => ({ status: "agent" })), closeRun: vi.fn(async () => undefined) };
  const tools = createManagedPiOwnerTools({ authority, signalFor: () => controller.signal, sharedBrowser: browser as never });
  return { tools, browser, controller, authority };
}
const request = (id: string, args: SharedBrowserAction = { action: "status" }) =>
  BotToolRequestSchema.parse({ toolCallId: id, capability: "browser.action", args });
function browserResult(result: BotToolResult) {
  if (!result.ok) throw new Error("Browser result was lost at the Pi tool boundary");
  return SharedBrowserActionResultSchema.parse(JSON.parse(result.content[0]!.text));
}
it("preserves a replacement run when an older delayed admission fails", async () => {
  const { tools, authority, browser } = setup();
  let release!: () => void;
  authority.mockImplementationOnce(() => new Promise(resolve => {
    release = () => resolve({ permissionMode: "full_access" });
  }));
  const oldAdmission = tools.open(binding, () => undefined);
  const oldFailure = expect(oldAdmission).rejects.toThrow();
  await tools.closeRun(binding.runId);
  await tools.open(binding, () => undefined);
  release();
  await oldFailure;
  await expect(tools.dispatch(binding, request("replacement_browser"), new AbortController().signal)).resolves.toMatchObject({ ok: true });
  expect(browser.execute).toHaveBeenCalledOnce();
});
it("registers exact Pi owner/chat/run and routes tools to the same broker, cleaning only the run", async () => {
  const { tools, browser } = setup();
  expect(tools.capabilities).toContain("browser.action");
  await tools.open(binding, () => undefined);
  expect(browser.openRun).toHaveBeenCalledWith({ ownerId: binding.ownerId, chatId: binding.chatId, runId: binding.runId, harness: "pi" }, expect.any(AbortSignal));
  await tools.dispatch(binding, request("browser_1"), new AbortController().signal);
  expect(browser.execute).toHaveBeenCalledWith({ ownerId: binding.ownerId, chatId: binding.chatId, runId: binding.runId, harness: "pi" }, { action: "status" }, expect.any(AbortSignal));
  await tools.closeRun(binding.runId);
  expect(browser.closeRun).toHaveBeenCalledOnce();
  await expect(tools.dispatch(binding, request("browser_late"), new AbortController().signal)).rejects.toThrow();
});
it("fails closed when full access is revoked or binding is stale, including action-time checks", async () => {
  const { tools, browser, authority, controller } = setup();
  await tools.open(binding, () => undefined);
  authority.mockResolvedValue({ permissionMode: "supervised" });
  await expect(tools.dispatch(binding, request("browser_denied"), new AbortController().signal)).rejects.toThrow();
  authority.mockResolvedValue({ permissionMode: "full_access" });
  await expect(tools.dispatch({ ...binding, chatId: "other" }, request("browser_other"), new AbortController().signal)).rejects.toThrow();
  controller.abort();
  await expect(tools.dispatch(binding, request("browser_aborted"), new AbortController().signal)).rejects.toThrow();
  expect(browser.execute).not.toHaveBeenCalled();
});
it("advertises nothing when browser is unavailable and does not register unauthorized runs", async () => {
  expect(createManagedPiOwnerTools({ authority: async () => ({ permissionMode: "full_access" }), signalFor: () => null }).capabilities).not.toContain("browser.action");
  const { tools, authority, browser } = setup();
  authority.mockResolvedValue({ permissionMode: "supervised" });
  await expect(tools.open(binding, () => undefined)).rejects.toThrow();
  expect(browser.openRun).not.toHaveBeenCalled();
});
it("keeps a known no-effect stale observation refusal observable without implying handoff", async () => {
  const { tools, browser } = setup();
  await tools.open(binding, () => undefined);
  browser.execute.mockRejectedValueOnce(new SharedBrowserError("observe_again"));
  Object.assign(browser, { status: () => ({ phase: "agent", revision: 3, run: { chatId: binding.chatId, runId: binding.runId, harness: "pi" }, needsObservation: true }) });
  const result = await tools.dispatch(binding, request("browser_stale_observation"), new AbortController().signal);
  expect(result.ok).toBe(true);
  if (result.ok) expect(JSON.parse(result.content[0]!.text)).toMatchObject({ success: false });
  expect(JSON.stringify(result)).toMatch(/observe Chrome again|fresh snapshot/i);
  expect(JSON.stringify(result)).not.toMatch(/resume|took over/i);
  browser.execute.mockRejectedValueOnce(new SharedBrowserError("browser_changed", true));
  await expect(tools.dispatch(binding, request("browser_unknown"), new AbortController().signal)).rejects.toThrow();
});
it.each([
  { code: "browser_changed", phase: "agent", runId: binding.runId, resume: false },
  { code: "browser_changed", phase: "paused", runId: binding.runId, resume: true },
  { code: "browser_changed", phase: "human", runId: binding.runId, resume: true },
  { code: "browser_changed", phase: "human", runId: "different_run", resume: false },
  { code: "browser_busy", phase: "human", runId: "different_run", resume: false },
] as const)("reports $code in $phase for $runId using the current run's state", async ({ code, phase, runId, resume }) => {
  const { tools, browser, controller } = setup();
  await tools.open(binding, () => undefined);
  browser.execute.mockRejectedValueOnce(new SharedBrowserError(code));
  Object.assign(browser, { status: () => ({ phase, revision: 3, run: { chatId: binding.chatId, runId, harness: "pi" }, needsObservation: true }) });
  const result = await tools.dispatch(binding, request("browser_control_changed", { action: "snapshot" }), controller.signal);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Browser refusal was lost at the Pi tool boundary");
  const { content } = SharedBrowserActionResultSchema.parse(JSON.parse(result.content[0]!.text));
  if (resume) expect(content).toMatch(/resume agent.*fresh snapshot/i);
  else expect(content).not.toMatch(/resume|took over/i);
});
it.each([true, false])("retains an uncertain click checkpoint and recovers without replay (CDP dispatch known: %s)", async dispatched => {
  let effects = 0;
  const execute = vi.fn<SharedBrowserDriver["execute"]>(async action => {
    if (action.action === "click") {
      effects++;
      throw new SharedBrowserError("browser_unavailable", dispatched);
    }
    return { success: true, observationId: `obs-${effects}`, content: `Recorded clicks: ${effects}` };
  });
  const browser = createSharedBrowserBroker({
    ownerId: binding.ownerId,
    driver: { execute, invalidateObservation: () => {}, detach: async () => {} },
    setHumanControl: async () => {},
  });
  const controller = new AbortController();
  const tools = createManagedPiOwnerTools({
    authority: async () => ({ permissionMode: "full_access" }),
    signalFor: () => controller.signal,
    sharedBrowser: browser,
  });
  const { db, destroy } = await createBotStateDatabase();
  const registry = new BotRuntimeRegistry();
  registry.bind(binding);
  const managedCheckpoints = createManagedPiCheckpointsRepository(db);
  const actions = createBotBrokerActions({
    db, registry, checkpoints: createBotCheckpointsRepository(db), sessions: createBotSessionsRepository(db),
    managedCheckpoints, managedSessions: createManagedPiSessionsRepository(db),
    tools: createBotToolDispatcher({ homePath: "/unused", managedTools: tools }),
    runs: { loadRunSpec: vi.fn(), readImageChunk: vi.fn() }, events: { publish: vi.fn() },
    inference: { homePath: "/unused", lifetime: controller.signal },
  });
  async function frame(id: string, args: SharedBrowserAction) {
    return BotBrokerResponseSchema.parse(await actions.handleFrame({
      version: 1, requestId: randomUUID(), runtimeHandle: binding.runtimeHandle, executionGeneration: binding.executionGeneration,
      runId: binding.runId, action: "bot.tool", tool: request(id, args),
    }));
  }
  const second = { ...binding, runId: "run_browser_after_stop" };
  async function dispatch(id: string, args: SharedBrowserAction) {
    const reply = await frame(id, args);
    if (!reply.ok) throw new Error(reply.code);
    return browserResult(BotToolResultSchema.parse(reply.result));
  }
  try {
    await insertChat(db, binding.chatId, binding.ownerId);
    await db.insertInto("chat_messages").values({
      id: "msg_browser", chat_id: binding.chatId, seq: 1, role: "user", state: "committed", purpose: "ai_request",
      turn_id: null, run_id: null, actor_id: binding.ownerId, parts: JSON.stringify([{ type: "text", text: "Click once." }]),
      byte_count: 11, search_text: "Click once.", created_at: NOW,
    }).execute();
    await db.insertInto("chat_turns").values({
      id: "cturn_browser", chat_id: binding.chatId, client_request_id: "req_browser", base_message_seq: 0,
      input_message_id: "msg_browser", status: "running", created_at: NOW, updated_at: NOW,
    }).execute();
    await db.insertInto("chat_runs").values({
      id: binding.runId, chat_id: binding.chatId, turn_id: "cturn_browser", client_request_id: "req_browser", attempt: 1,
      driver_kind: "matrix_pi", instance_id: "matrix_pi_default", selection: JSON.stringify({ instanceId: "matrix_pi_default", model: binding.route.modelId }),
      interaction_mode: "default", permission_mode: "full_access", status: "running", history_boundary_seq: 0,
      capability_snapshot: "{}", created_at: NOW, updated_at: NOW,
    }).execute();
    await tools.open(binding, () => undefined);
    const first = await dispatch("first_snapshot", { action: "snapshot" });
    expect(first).toMatchObject({ success: true, observationId: "obs-0", content: "Recorded clicks: 0" });
    const click = { action: "click", observationId: "obs-0", ref: "submit" } as const;
    const uncertain = await dispatch("click_once", click);
    expect(uncertain).toMatchObject({
      success: false, content: expect.stringMatching(dispatched ? /effect is uncertain.*never replay.*Stop agent.*new run/i : /Stop agent.*new run.*verify/i),
      automation: { phase: "unavailable", run: { runId: binding.runId } },
    });
    expect(uncertain.content).not.toMatch(/resume|took over/i);
    const checkpoint = { toolCallId: "click_once", phase: "effect_unknown", effectClass: "write", outcomeRef: null };
    expect(await managedCheckpoints.listForRun(binding)).toContainEqual(expect.objectContaining(checkpoint));
    expect(await frame("click_once", click)).toMatchObject({ ok: false, code: "denied" });
    expect(await dispatch("status_after_click", { action: "status" })).toMatchObject({
      success: true, automation: { phase: "unavailable", run: { runId: binding.runId } },
    });
    const blocked = await dispatch("snapshot_while_unavailable", { action: "snapshot" });
    expect(blocked).toMatchObject({ success: false, content: expect.stringMatching(/Stop agent.*new run.*verify/i) });
    expect(blocked.content).not.toMatch(/resume|took over/i);
    expect(await managedCheckpoints.listForRun(binding)).toEqual(expect.arrayContaining([
      expect.objectContaining(checkpoint),
      expect.objectContaining({ toolCallId: "snapshot_while_unavailable", phase: "observed_complete" }),
    ]));
    await expect(browser.control(binding.ownerId, { action: "resume" })).rejects.toMatchObject({ code: "run_unavailable" });
    expect(await browser.control(binding.ownerId, { action: "stop" })).toMatchObject({ phase: "idle", run: null });
    expect(await frame("retired_snapshot", { action: "snapshot" })).toMatchObject({ ok: false, code: "stale_generation" });
    await tools.closeRun(binding.runId);
    await tools.open(second, () => undefined);
    expect(browserResult(await tools.dispatch(second, request("fresh_snapshot", { action: "snapshot" }), controller.signal))).toMatchObject({
      success: true, observationId: "obs-1", content: "Recorded clicks: 1",
    });
    expect(execute.mock.calls.map(([action]) => action.action)).toEqual(["snapshot", "click", "snapshot"]);
    expect(effects).toBe(1);
  } finally {
    await tools.closeRun(binding.runId);
    await tools.closeRun(second.runId);
    await browser.close();
    await destroy();
  }
});
it("offers Stop when the input gate fails before Pi dispatches an action", async () => {
  const execute = vi.fn<SharedBrowserDriver["execute"]>();
  const gate = vi.fn<(_: boolean) => Promise<void>>().mockResolvedValue(undefined)
    .mockRejectedValueOnce(new Error("Synthetic input gate failure"));
  const browser = createSharedBrowserBroker({
    ownerId: binding.ownerId,
    driver: { execute, invalidateObservation: () => {}, detach: async () => {} },
    setHumanControl: gate,
  });
  const controller = new AbortController();
  const tools = createManagedPiOwnerTools({
    authority: async () => ({ permissionMode: "full_access" }),
    signalFor: () => controller.signal,
    sharedBrowser: browser,
  });
  try {
    await tools.open(binding, () => undefined);
    const { result } = await tools.dispatch(binding, request("gate_failure_snapshot", { action: "snapshot" }), controller.signal)
      .then(() => { throw new Error("Unavailable Browser result bypassed the broker checkpoint"); }, (error: unknown) => {
        if (!(error instanceof BotBrokerToolEffectUnknownError)) throw error;
        return error;
      });
    const value = browserResult(result);
    expect(value).toMatchObject({
      success: false, content: expect.stringMatching(/Stop agent/i),
      automation: { phase: "unavailable", run: { runId: binding.runId } },
    });
    expect(value.content).not.toMatch(/resume|took over|synthetic input gate failure/i);
    expect(execute).not.toHaveBeenCalled();
    await expect(browser.control(binding.ownerId, { action: "stop" })).resolves.toMatchObject({ phase: "idle" });
  } finally {
    await tools.closeRun(binding.runId);
    await browser.close();
  }
});
it("continues a Pi turn without Browser if its scoped capability expired before setup", async () => {
  const { tools, authority, browser } = setup();
  authority.mockResolvedValue({ permissionMode: "supervised" });
  Object.assign(browser, { authorizeAction: vi.fn(async () => {}), allowsSupervisedRun: vi.fn(() => false) });
  await expect(tools.open(binding, () => undefined)).resolves.toBeUndefined();
  expect(browser.openRun).not.toHaveBeenCalled();
  await expect(tools.dispatch(binding, request("browser_expired"), new AbortController().signal)).rejects.toThrow();
  expect(browser.execute).not.toHaveBeenCalled();
  await tools.closeRun(binding.runId);
});
it("returns actionable tab capacity guidance to Pi without asking the owner to resume", async () => {
  const { tools, browser } = setup();
  await tools.open(binding, () => undefined);
  browser.execute.mockRejectedValueOnce(new SharedBrowserError("tab_limit"));
  Object.assign(browser, { status: () => ({ phase: "agent", revision: 3, run: { chatId: binding.chatId, runId: binding.runId, harness: "pi" }, needsObservation: true }) });
  const result = await tools.dispatch(binding, BotToolRequestSchema.parse({
    toolCallId: "browser_tab_limit", capability: "browser.action", args: { action: "tab_new" },
  }), new AbortController().signal);
  expect(result.ok).toBe(true);
  if (result.ok) expect(JSON.parse(result.content[0]!.text)).toMatchObject({
    success: false,
    content: expect.stringMatching(/tab limit.*existing tab/i),
    automation: { phase: "agent" },
  });
  expect(JSON.stringify(result)).not.toMatch(/resume/i);
});

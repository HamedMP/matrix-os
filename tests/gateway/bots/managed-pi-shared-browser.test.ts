import { expect, it, vi } from "vitest";
import { BotToolRequestSchema, SharedBrowserActionResultSchema, type SharedBrowserAction } from "@matrix-os/contracts";
import { createManagedPiOwnerTools } from "../../../packages/gateway/src/chat/managed-pi-owner-tools.js";
import type { ManagedPiRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { createSharedBrowserBroker, SharedBrowserError, type SharedBrowserDriver } from "../../../packages/gateway/src/shared-browser/broker.js";
const binding = { kind: "managed_chat", ownerId: "owner_qa", chatId: "chat_qa", runId: "run_browser_qa", runtimeHandle: `runtime_${"a".repeat(32)}`,
  executionGeneration: "1", capabilities: ["browser.action"], workspace: { kind: "chat_workspace" }, rootFingerprint: "a".repeat(64) } as ManagedPiRuntimeBinding;
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
it("recovers a dispatched uncertain click through Stop and a fresh Pi run without replay", async () => {
  let effects = 0;
  const execute = vi.fn<SharedBrowserDriver["execute"]>(async action => {
    if (action.action === "click") {
      effects++;
      throw new SharedBrowserError("browser_unavailable", true);
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
  const second = { ...binding, runId: "run_browser_after_stop" };
  async function dispatch(run: ManagedPiRuntimeBinding, id: string, args: SharedBrowserAction) {
    const result = await tools.dispatch(run, request(id, args), controller.signal);
    if (!result.ok) throw new Error("Browser result was lost at the Pi tool boundary");
    return SharedBrowserActionResultSchema.parse(JSON.parse(result.content[0]!.text));
  }
  try {
    await tools.open(binding, () => undefined);
    const first = await dispatch(binding, "first_snapshot", { action: "snapshot" });
    expect(first).toMatchObject({ success: true, observationId: "obs-0", content: "Recorded clicks: 0" });
    const click = { action: "click", observationId: "obs-0", ref: "submit" } as const;
    const uncertain = await dispatch(binding, "click_once", click);
    expect(uncertain).toMatchObject({
      success: false, content: expect.stringMatching(/effect is uncertain.*never replay.*Stop agent.*new run/i),
      automation: { phase: "unavailable", run: { runId: binding.runId } },
    });
    expect(uncertain.content).not.toMatch(/resume|took over/i);
    expect(await dispatch(binding, "status_after_click", { action: "status" })).toMatchObject({
      success: true, automation: { phase: "unavailable", run: { runId: binding.runId } },
    });
    const blocked = await dispatch(binding, "snapshot_while_unavailable", { action: "snapshot" });
    expect(blocked).toMatchObject({ success: false, content: expect.stringMatching(/Stop agent.*new run.*verify/i) });
    expect(blocked.content).not.toMatch(/resume|took over/i);
    await expect(browser.control(binding.ownerId, { action: "resume" })).rejects.toMatchObject({ code: "run_unavailable" });
    expect(await browser.control(binding.ownerId, { action: "stop" })).toMatchObject({ phase: "idle", run: null });
    await expect(dispatch(binding, "retired_snapshot", { action: "snapshot" })).rejects.toMatchObject({ code: "stale_generation" });
    await tools.closeRun(binding.runId);
    await tools.open(second, () => undefined);
    expect(await dispatch(second, "fresh_snapshot", { action: "snapshot" })).toMatchObject({
      success: true, observationId: "obs-1", content: "Recorded clicks: 1",
    });
    expect(execute.mock.calls.map(([action]) => action.action)).toEqual(["snapshot", "click", "snapshot"]);
    expect(effects).toBe(1);
  } finally {
    await tools.closeRun(binding.runId);
    await tools.closeRun(second.runId);
    await browser.close();
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
    const response = await tools.dispatch(binding, request("gate_failure_snapshot", { action: "snapshot" }), controller.signal);
    if (!response.ok) throw new Error("Browser unavailable result was lost at the Pi tool boundary");
    const result = SharedBrowserActionResultSchema.parse(JSON.parse(response.content[0]!.text));
    expect(result).toMatchObject({
      success: false, content: expect.stringMatching(/Stop agent/i),
      automation: { phase: "unavailable", run: { runId: binding.runId } },
    });
    expect(result.content).not.toMatch(/resume|took over|synthetic input gate failure/i);
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

import { afterEach, expect, it, vi } from "vitest";
import { registerOpenClawSharedBrowserPlugin } from "../../packages/gateway/src/chat/openclaw-shared-browser-plugin.js";

const RUN = "run_private_synthetic", SESSION = "agent:main:private_synthetic", CALL = "call_private_synthetic";
const CONTEXT = { runId: RUN, sessionKey: SESSION, toolCallId: CALL, toolName: "shared_browser" };
const ACTION = { action: "tab_new", url: "http://127.0.0.1:8730/invoices" };
const EVENT = { toolName: "shared_browser", params: ACTION, runId: RUN, sessionKey: SESSION, toolCallId: CALL };
const closes: Array<() => void> = [];
afterEach(() => { for (const close of closes.splice(0)) close(); vi.restoreAllMocks(); });
function setup() {
  const methods = new Map<string, (value: { params: unknown; respond(ok: boolean, result?: unknown, error?: unknown): void }) => Promise<void>>();
  const hooks = new Map<string, (event: unknown, context: unknown) => unknown>();
  let factory: (value: { sessionKey: string }) => { execute(id: string, params: unknown): Promise<unknown> };
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ success: true }));
  const close = registerOpenClawSharedBrowserPlugin({
    registerGatewayMethod: (name, handler) => methods.set(name, handler),
    on: (name, handler) => hooks.set(name, handler as never),
    registerTool: value => { factory = value as typeof factory; },
  }, { gatewayPort: 4000, fetcher });
  closes.push(close);
  const bind = async () => {
    const respond = vi.fn();
    await methods.get("matrix.browser.bind")!({ params: { runId: RUN, sessionKey: SESSION,
      token: "s".repeat(43), expiresAt: Date.now() + 60_000 }, respond });
    expect(respond).toHaveBeenCalledWith(true, { bound: true });
  };
  return { fetcher, close, bind, hook: (event: unknown = EVENT, context: unknown = CONTEXT) => hooks.get("before_tool_call")!(event, context),
    execute: (params: unknown) => factory!({ sessionKey: SESSION }).execute(CALL, params) };
}
function assertDenial(result: unknown, reason: string, warn: ReturnType<typeof vi.spyOn>) {
  expect(result).toMatchObject({ block: true });
  const rendered = JSON.stringify(result);
  expect(rendered).toContain("browser binding is unavailable");
  expect(rendered).not.toMatch(/paus|resum/i);
  expect(warn).toHaveBeenCalledExactlyOnceWith("[shared-browser-openclaw] Tool binding refused", reason);
  expect(JSON.stringify(warn.mock.calls)).not.toContain(RUN);
  expect(JSON.stringify(warn.mock.calls)).not.toContain(SESSION);
  expect(JSON.stringify(warn.mock.calls)).not.toContain(CALL);
  expect(JSON.stringify(warn.mock.calls)).not.toContain(ACTION.url);
  expect(JSON.stringify(warn.mock.calls)).not.toContain("s".repeat(43));
}
it.each([
  ["closed", CONTEXT],
  ["run_context_missing", { ...CONTEXT, runId: undefined }],
  ["lease_missing", { ...CONTEXT, runId: "run_foreign_private" }],
  ["session_mismatch", { ...CONTEXT, sessionKey: "agent:main:foreign_private" }],
  ["call_context_missing", { ...CONTEXT, toolCallId: undefined }],
] as const)("reports %s truthfully without trusting the event's identities", async (reason, context) => {
  const s = setup(); await s.bind();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  if (reason === "closed") s.close();
  assertDenial(s.hook(EVENT, context), reason, warn);
  expect(s.fetcher).toHaveBeenCalledTimes(1);
});
it("reports an authenticating reservation without issuing a browser action", async () => {
  const s = setup(), pending = Promise.withResolvers<Response>();
  s.fetcher.mockImplementationOnce(async () => pending.promise);
  const binding = s.bind();
  await vi.waitFor(() => expect(s.fetcher).toHaveBeenCalledOnce());
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try { assertDenial(s.hook(), "unauthenticated", warn); expect(s.fetcher).toHaveBeenCalledOnce(); }
  finally { pending.resolve(Response.json({ success: true })); await binding; }
});
it("reports invalid action without logging its untrusted fields", async () => {
  const s = setup(); await s.bind();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  assertDenial(s.hook({ ...EVENT, params: { ...ACTION, token: "untrusted_secret", runId: RUN } }), "invalid_action", warn);
  expect(JSON.stringify(warn.mock.calls)).not.toContain("untrusted_secret");
  expect(s.fetcher).toHaveBeenCalledTimes(1);
});
it("reports the existing one-use ticket limit and keeps the transport unchanged", async () => {
  const s = setup(); await s.bind();
  for (let index = 0; index < 128; index++) expect(s.hook(EVENT, { ...CONTEXT, toolCallId: `call_${index}` })).toHaveProperty("params");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  assertDenial(s.hook(), "ticket_capacity", warn);
  expect(s.fetcher).toHaveBeenCalledTimes(1);
});
it("still executes only the exact authenticated call and rejects replay", async () => {
  const s = setup(); await s.bind();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const stamped = s.hook() as { params: unknown };
  await s.execute(stamped.params);
  expect(s.fetcher).toHaveBeenCalledTimes(2);
  expect(s.fetcher).toHaveBeenLastCalledWith("http://127.0.0.1:4000/apps/browser-lab/api/agent-action",
    expect.objectContaining({ body: JSON.stringify(ACTION) }));
  expect(warn).not.toHaveBeenCalled();
  await expect(s.execute(stamped.params)).rejects.toThrow("Browser action unavailable");
  expect(s.fetcher).toHaveBeenCalledTimes(2);
});

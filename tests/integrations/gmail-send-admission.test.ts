import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNativeGmailClient } from "../../packages/gateway/src/integrations/native-gmail/client.js";
import { createPipedreamClient } from "../../packages/gateway/src/integrations/pipedream.js";
import { executeIntegrationAction } from "../../packages/gateway/src/integrations/action-execution.js";
import { GMAIL_SERVICE } from "../../packages/gateway/src/integrations/gmail.js";

const mocks = vi.hoisted(() => ({ token: vi.fn(), get: vi.fn(), post: vi.fn(), revoke: vi.fn(), run: vi.fn() }));
vi.mock("@pipedream/sdk", () => ({ PipedreamClient: class {
  proxy = { get: mocks.get, post: mocks.post };
  accounts = { delete: mocks.revoke };
  actions = { run: mocks.run };
  get rawAccessToken() { return mocks.token(); }
} }));
const base = "https://gmail.googleapis.com/gmail/v1/users/me";
const nativeAccount = "gmail_11111111-1111-4111-8111-111111111111";
const identity = { externalUserId: "owner", accountId: "apn_fixture" };
const config = { clientId: "synthetic", clientSecret: "synthetic", projectId: "fixture" };
const response = () => Response.json({ id: "message", historyId: "1", size: 1, data: "YQ" });
const actions: Record<string, Record<string, unknown>> = {
  get_profile: {}, list_threads: {}, get_thread_ids: { threadId: "thread" }, list_messages: {},
  get_message: { messageId: "message" }, get_message_text: { messageId: "message" }, get_attachment: { messageId: "message", attachmentId: "attachment" },
  send_email: { to: "test@example.test", subject: "Subject", body: "a".repeat(60_000) },
  create_draft: { subject: "Draft", body: "Draft content" }, search: { query: "in:inbox" }, list_labels: {},
  list_history: { startHistoryId: "9007199254740993" }, create_label: { name: "Reviewed" },
  modify_message: { messageId: "message", addLabelIds: ["Label_one"] },
  delete_unused_label: { labelId: "Label_123", expectedName: "Synthetic" },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(native: boolean) {
  const fetcher = vi.fn<typeof fetch>(async () => response());
  vi.stubGlobal("fetch", fetcher);
  const legacy = await createPipedreamClient(config);
  const token = vi.fn(async () => "synthetic");
  return { client: native ? createNativeGmailClient({ legacy, oauth: { token }, fetcher }) : legacy,
    fetcher, token: native ? token : mocks.token, accountId: native ? nativeAccount : identity.accountId };
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.token.mockResolvedValue("synthetic"); mocks.get.mockResolvedValue({ legacy: true });
  mocks.post.mockResolvedValue({ legacy: true }); mocks.revoke.mockResolvedValue(undefined);
  mocks.run.mockResolvedValue({ ret: { unguarded: true } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe.each([false, true])("Gmail send admission native=%s", native => {
  it.each(["get_profile", "create_label"])("propagates parent cancellation through guarded %s action streams after admission", async actionId => {
    const f = await fixture(native); const controller = new AbortController(); const cancelled = vi.fn();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    f.fetcher.mockImplementation(async () => new Response(new ReadableStream({ start(value) {
      stream = value; value.enqueue(new TextEncoder().encode("{"));
    }, cancel: cancelled })));
    const beforeSend = vi.fn(async () => undefined);
    const pending = executeIntegrationAction({ pipedream: f.client, externalUserId: identity.externalUserId,
      connection: { pipedream_account_id: f.accountId }, def: GMAIL_SERVICE, actionDef: GMAIL_SERVICE.actions[actionId],
      serviceId: "gmail", actionId, params: actions[actionId], beforeSend, signal: controller.signal })
      .then(() => "released", () => "denied");
    try {
      await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
      controller.abort();
      expect(f.fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
      expect(await pending).toBe("denied"); expect(cancelled).toHaveBeenCalledOnce();
    } finally {
      try { stream.close(); } catch (error) { if (!(error instanceof TypeError)) throw error; }
      await pending;
    }
  });
  it("aborts the generic request during its token wait and prevents a late send", async () => {
    const f = await fixture(native); const token = deferred<string>(); f.token.mockReturnValue(token.promise);
    const controller = new AbortController(); const beforeSend = vi.fn(async () => undefined);
    const pending = f.client.proxyGet({ ...identity, accountId: f.accountId, url: `${base}/profile` }, beforeSend, controller.signal)
      .then(() => "released", () => "denied");
    await vi.waitFor(() => expect(f.token).toHaveBeenCalled());
    controller.abort(); token.resolve("late");
    expect(await pending).toBe("denied"); expect(f.fetcher).not.toHaveBeenCalled(); expect(beforeSend).not.toHaveBeenCalled();
  });
  it("aborts the generic request while an admission callback ignores cancellation", async () => {
    const f = await fixture(native); const held = deferred<void>(); const controller = new AbortController();
    const beforeSend = vi.fn(async () => held.promise);
    const pending = f.client.proxyGet({ ...identity, accountId: f.accountId, url: `${base}/profile` }, beforeSend, controller.signal)
      .then(() => "released", () => "denied");
    await vi.waitFor(() => expect(beforeSend).toHaveBeenCalledOnce()); controller.abort();
    try { expect(await pending).toBe("denied"); expect(f.fetcher).not.toHaveBeenCalled(); }
    finally { held.resolve(); }
    await new Promise(resolve => setTimeout(resolve, 0)); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("propagates parent cancellation through guarded callAction streams", async () => {
    const f = await fixture(native); const controller = new AbortController(); const cancelled = vi.fn();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    f.fetcher.mockImplementation(async () => new Response(new ReadableStream({ start(value) {
      stream = value; value.enqueue(new TextEncoder().encode("{"));
    }, cancel: cancelled })));
    const pending = f.client.callAction({ ...identity, accountId: f.accountId, url: `${base}/labels`, body: { name: "Reviewed" } },
      async () => undefined, controller.signal).then(() => "released", () => "denied");
    try {
      await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce()); controller.abort();
      expect(f.fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
      expect(await pending).toBe("denied"); expect(cancelled).toHaveBeenCalledOnce();
    } finally {
      try { stream.close(); } catch (error) { if (!(error instanceof TypeError)) throw error; }
      await pending;
    }
  });
  it.each(["proxyGet", "proxyPost", "boundedGmailGet", "boundedGmailLabels"] as const)("rechecks %s after credential wait and sends nothing after revocation", async method => {
    const f = await fixture(native); const token = deferred<string>(); f.token.mockReturnValue(token.promise);
    let valid = true;
    const beforeSend = vi.fn(async () => { if (!valid) throw new Error("Admission unavailable"); });
    const call = method === "proxyGet" ? f.client.proxyGet({ ...identity, accountId: f.accountId, url: `${base}/profile` }, beforeSend)
      : method === "proxyPost" ? f.client.proxyPost({ ...identity, accountId: f.accountId, url: `${base}/labels`, body: { name: "Reviewed" } }, beforeSend)
      : method === "boundedGmailGet" ? f.client.boundedGmailGet!({ ...identity, accountId: f.accountId, kind: "profile" }, undefined, beforeSend)
      : f.client.boundedGmailLabels!({ ...identity, accountId: f.accountId, kind: "labels" }, undefined, beforeSend);
    const result = call.then(() => "sent", () => "denied");
    await vi.waitFor(() => expect(f.token).toHaveBeenCalled());
    valid = false; token.resolve("resolved_after_revocation");
    expect(await result).toBe("denied"); expect(beforeSend).toHaveBeenCalledOnce();
    expect(f.fetcher).not.toHaveBeenCalled(); expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled();
  });
  it("does not share admission or cancellation between identical concurrent reads", async () => {
    const f = await fixture(native); const allowed = deferred<void>(); const denied = deferred<void>();
    const firstGuard = vi.fn(async () => { await allowed.promise; });
    const secondGuard = vi.fn(async () => { await denied.promise; throw new Error("Denied"); });
    const input = { ...identity, accountId: f.accountId, url: `${base}/profile` };
    const first = f.client.proxyGet(input, firstGuard);
    const second = f.client.proxyGet(input, secondGuard).then(() => "sent", () => "denied");
    await vi.waitFor(() => { expect(firstGuard).toHaveBeenCalledOnce(); expect(secondGuard).toHaveBeenCalledOnce(); });
    denied.resolve(); expect(await second).toBe("denied"); expect(f.fetcher).not.toHaveBeenCalled();
    allowed.resolve(); await first; expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it.each(["boundedGmailGet", "boundedGmailLabels"] as const)("checks cancellation again immediately before %s sends", async method => {
    const f = await fixture(native); const controller = new AbortController();
    const guard = async () => { queueMicrotask(() => queueMicrotask(() => controller.abort())); };
    const pending = f.client[method]!({ ...identity, accountId: f.accountId, kind: method === "boundedGmailGet" ? "profile" : "labels" }, controller.signal, guard);
    await expect(pending).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each(Object.entries(actions))("guards the reviewed %s catalog action without entering the SDK proxy", async (actionId, params) => {
    const f = await fixture(native); const beforeSend = vi.fn(async (signal: AbortSignal) => { expect(signal.aborted).toBe(false); });
    expect(Object.keys(GMAIL_SERVICE.actions).sort()).toEqual(Object.keys(actions).sort());
    if (actionId === "get_message_text" || actionId === "delete_unused_label") {
      if (!native) {
        await expect(executeIntegrationAction({ pipedream: f.client, externalUserId: identity.externalUserId,
          connection: { pipedream_account_id: f.accountId }, def: GMAIL_SERVICE, actionDef: GMAIL_SERVICE.actions[actionId],
          serviceId: "gmail", actionId, params, beforeSend })).rejects.toThrow();
        expect(beforeSend).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
        expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled(); return;
      }
      if (actionId === "delete_unused_label") {
        f.fetcher.mockResolvedValueOnce(Response.json({ id: "Label_123", name: "Synthetic", type: "user", messagesTotal: 0, threadsTotal: 0 }))
          .mockResolvedValueOnce(Response.json({})).mockResolvedValueOnce(new Response(null, { status: 404 }));
      } else {
        const payload = { mimeType: "text/plain", filename: "", body: { size: 1 } };
        f.fetcher.mockResolvedValueOnce(Response.json({ id: "message", payload }))
          .mockResolvedValueOnce(Response.json({ id: "message", payload: { ...payload, body: { size: 1, data: "YQ" } } }));
      }
    }
    await executeIntegrationAction({ pipedream: f.client, externalUserId: identity.externalUserId,
      connection: { pipedream_account_id: f.accountId }, def: GMAIL_SERVICE, actionDef: GMAIL_SERVICE.actions[actionId],
      serviceId: "gmail", actionId, params, beforeSend });
    expect(Object.keys(GMAIL_SERVICE.actions).sort()).toEqual(Object.keys(actions).sort());
    const sends = actionId === "delete_unused_label" ? 3 : actionId === "get_message_text" ? 2 : 1;
    expect(beforeSend).toHaveBeenCalledTimes(sends); expect(f.fetcher).toHaveBeenCalledTimes(sends);
    expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled();
    const [url, init] = f.fetcher.mock.calls[0]!;
    expect(init?.redirect).toBe("error"); expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (!native) {
      const target = new URL(String(url)); expect(target.origin).toBe("https://api.pipedream.com");
      expect(target.searchParams.get("account_id")).toBe(identity.accountId);
    }
    if (actionId === "send_email") {
      expect(Buffer.byteLength(String(init?.body))).toBeGreaterThan(65_536);
      expect(Buffer.from(JSON.parse(String(init?.body)).raw, "base64url").toString()).toContain("a".repeat(60_000));
    }
  });
});

it("bounds a send guard that ignores cancellation and never sends when it later settles", async () => {
  const f = await fixture(false); const guard = deferred<void>(); let settled = false;
  vi.useFakeTimers();
  // Node's native AbortSignal timer does not use Vitest's clock. Keep its signal semantics with a test-clock timer.
  vi.spyOn(AbortSignal, "timeout").mockImplementation(delay => {
    const controller = new AbortController(); setTimeout(() => controller.abort(), delay); return controller.signal;
  });
  const pending = f.client.boundedGmailGet!({ ...identity, kind: "profile" }, undefined, () => guard.promise)
    .then(() => { settled = true; }, () => { settled = true; });
  try {
    await vi.advanceTimersByTimeAsync(10_001);
    expect(settled).toBe(true);
    expect(f.fetcher).not.toHaveBeenCalled();
  } finally { guard.resolve(); await pending; }
  expect(f.fetcher).not.toHaveBeenCalled();
});

it("retains unguarded SDK owner reads/writes and account revocation", async () => {
  const f = await fixture(false);
  expect(await f.client.proxyGet({ ...identity, url: `${base}/profile` })).toEqual({ legacy: true });
  await f.client.proxyPost({ ...identity, url: `${base}/labels`, body: { name: "Owner" } });
  await f.client.revokeAccount(identity.accountId);
  expect(mocks.get).toHaveBeenCalledOnce(); expect(mocks.post).toHaveBeenCalledOnce(); expect(mocks.revoke).toHaveBeenCalledOnce();
  expect(f.fetcher).not.toHaveBeenCalled();
});
it("keeps explicitly cancellable legacy SDK reads independent while preserving owner reads", async () => {
  const f = await fixture(false); const first = new AbortController(); const second = new AbortController();
  const held = deferred<unknown>(); mocks.get.mockReturnValue(held.promise);
  const input = { ...identity, url: `${base}/profile` };
  const one = f.client.proxyGet(input, undefined, first.signal); const two = f.client.proxyGet(input, undefined, second.signal);
  try {
    await vi.waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    first.abort(); expect(mocks.get.mock.calls[0]![1].abortSignal.aborted).toBe(true);
    expect(mocks.get.mock.calls[1]![1].abortSignal.aborted).toBe(false);
    expect(f.fetcher).not.toHaveBeenCalled();
  } finally { held.resolve({ legacy: true }); await Promise.all([one, two]); }
});

it.each(["https://other.example/profile", `${base}/messages/../profile`, `${base}/messages/%2e%2e/profile`,
  `${base}/messages/id/trash`, `${base}/profile?access_token=forged`, `${base}/messages?maxResults=501`,
  "https://user@gmail.googleapis.com/gmail/v1/users/me/profile", `${base}/profile#fragment`])("rejects a guarded noncatalog target %s before credentials or SDK fallback", async url => {
  const f = await fixture(false); const guard = vi.fn();
  await expect(f.client.proxyGet({ ...identity, url }, guard)).rejects.toThrow("Gmail request unavailable");
  expect(f.token).not.toHaveBeenCalled(); expect(guard).not.toHaveBeenCalled();
  expect(f.fetcher).not.toHaveBeenCalled(); expect(mocks.get).not.toHaveBeenCalled();
});
it.each([
  ["messages/send", { raw: "abc", credentials: "forged" }], ["messages/send", { raw: "x".repeat(128 * 1024) }],
  ["messages/id/modify", { addLabelIds: ["TRASH"] }], ["labels", { name: "   " }],
  ["drafts", { message: { raw: "abc", headers: "forged" } }],
])("rejects invalid guarded %s bodies without token access", async (path, body) => {
  const f = await fixture(false);
  await expect(f.client.proxyPost({ ...identity, url: `${base}/${path}`, body }, async () => undefined)).rejects.toThrow("Gmail request unavailable");
  expect(f.token).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled();
});
it.each(["proxyPut", "proxyPatch", "proxyDelete"] as const)("never uses SDK fallback for unsupported guarded Gmail %s", async method => {
  const f = await fixture(false);
  await expect(f.client[method]({ ...identity, url: `${base}/labels` }, async () => undefined)).rejects.toThrow("Gmail request unavailable");
  expect(f.token).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
});
it.each(["declared", "streamed", "chunks", "attachment", "invalid-json", "redirect", "upstream-error"])("bounds guarded Gmail %s responses without retries or raw error details", async mode => {
  const f = await fixture(false); const cancelled = vi.fn(); const guard = vi.fn(async () => undefined);
  f.fetcher.mockImplementation(async () => {
    if (mode === "declared") return new Response(new ReadableStream({ cancel: cancelled }), { headers: { "content-length": String(2 * 1024 * 1024 + 1) } });
    if (mode === "streamed" || mode === "chunks") return new Response(new ReadableStream({ start(controller) {
      if (mode === "streamed") controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
      else for (let count = 0; count < 4097; count++) controller.enqueue(new Uint8Array([32]));
    }, cancel: cancelled }));
    if (mode === "attachment") return Response.json({ size: 2, data: "YQ" });
    if (mode === "invalid-json") return new Response("private invalid upstream response");
    return new Response("private upstream failure", { status: mode === "redirect" ? 302 : 503 });
  });
  await expect(f.client.proxyGet({ ...identity, url: `${base}/${mode === "attachment" ? "messages/id/attachments/id" : "profile"}` }, guard)).rejects.toThrow("Gmail request unavailable");
  expect(f.fetcher).toHaveBeenCalledOnce(); expect(guard).toHaveBeenCalledOnce(); expect(mocks.get).not.toHaveBeenCalled();
  if (["declared", "streamed", "chunks"].includes(mode)) expect(cancelled).toHaveBeenCalled();
});
it("does not retry a guarded write after a failed response", async () => {
  const f = await fixture(false); f.fetcher.mockResolvedValue(new Response("private", { status: 503 }));
  const guard = vi.fn(async () => undefined);
  await expect(f.client.callAction({ ...identity, url: `${base}/labels`, body: { name: "Reviewed" } }, guard)).rejects.toThrow("Gmail request unavailable");
  expect(guard).toHaveBeenCalledOnce(); expect(f.fetcher).toHaveBeenCalledOnce(); expect(mocks.post).not.toHaveBeenCalled();
});
it("fails closed instead of dispatching a future component-only guarded Gmail action", async () => {
  const f = await fixture(false);
  await expect(executeIntegrationAction({ pipedream: f.client, externalUserId: identity.externalUserId,
    connection: { pipedream_account_id: identity.accountId }, def: GMAIL_SERVICE,
    actionDef: { ...GMAIL_SERVICE.actions.get_profile, directApi: undefined, componentKey: "gmail-unreviewed" },
    serviceId: "gmail", actionId: "future_component", params: {}, beforeSend: async () => undefined })).rejects.toThrow();
  expect(mocks.run).not.toHaveBeenCalled();
});
it("does not pass Gmail send authority to other integration actions", async () => {
  const f = await fixture(false); const beforeSend = vi.fn(async () => undefined);
  await executeIntegrationAction({ pipedream: f.client, externalUserId: identity.externalUserId,
    connection: { pipedream_account_id: identity.accountId }, def: { ...GMAIL_SERVICE, id: "other_service" },
    actionDef: { ...GMAIL_SERVICE.actions.get_profile, directApi: { method: "GET", url: "https://other.example/profile" } },
    serviceId: "other_service", actionId: "get_profile", params: {}, beforeSend });
  expect(beforeSend).not.toHaveBeenCalled(); expect(mocks.get).toHaveBeenCalledOnce(); expect(f.fetcher).not.toHaveBeenCalled();
});
it.each(["token", "guard", "stream"])("bounds a guarded raw Gmail %s wait and prevents late sends", async phase => {
  const f = await fixture(false); const held = deferred<string>(); const cancelled = vi.fn();
  if (phase === "token") f.token.mockReturnValue(held.promise);
  if (phase === "stream") f.fetcher.mockResolvedValue(new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode("{"));
  }, cancel: cancelled })));
  vi.useFakeTimers();
  const pending = f.client.proxyGet({ ...identity, url: `${base}/profile` }, async () => {
    if (phase === "guard") await held.promise;
  }).then(() => "sent", () => "denied");
  try {
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await pending).toBe("denied");
  } finally { held.resolve("late"); }
  await vi.advanceTimersByTimeAsync(1);
  expect(f.fetcher).toHaveBeenCalledTimes(phase === "stream" ? 1 : 0);
  if (phase === "stream") expect(cancelled).toHaveBeenCalledOnce();
});

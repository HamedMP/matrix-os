import { lstat, mkdtemp, rm, symlink } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { BotIntegrationClient } from "../../packages/gateway/src/bots/integration-client.js";
import { createHostedBotsDriveApproval } from "../../packages/gateway/src/hosted-bots/drive-approval.js";
import { bindHostedBotsDriveSocket, HOSTED_BOTS_DRIVE_BASE } from "../../packages/gateway/src/hosted-bots/drive-approval-runtime.js";

const ownerId = "user_preview_owner";
const fileId = "fixture-document";
const accountId = "account-fixture";
const githubAccountId = "account-github";
const githubRead = { service: "github", action: "list_prs", params: { repo: "HamedMP/matrix-os", per_page: 1 } };
const json = { "content-type": "application/json" };
const authenticated = { ...json, "x-test-owner": ownerId };

function setup(options: { timeoutMs?: number; admitted?: boolean } = {}) {
  const inventory = vi.fn(async () => [
    { connectionId: accountId, service: "google_drive", label: "Test Drive", email: "fixture@example.com" },
    { connectionId: "another-service", service: "gmail", label: "Test Gmail" },
    { connectionId: githubAccountId, service: "github", label: "Test GitHub", email: "hidden@example.com" },
  ]);
  const call = vi.fn<BotIntegrationClient["call"]>(async () => ({ data: { fileId, name: "Fixture", content: "QA receipt" } }));
  const describeActions = vi.fn<BotIntegrationClient["describe"]>(async () => [
    { id: "list_prs", description: "List pull requests", risk: "read", params: {} },
  ]);
  const broker = createHostedBotsDriveApproval({
    admitted: options.admitted ?? true,
    ownerId,
    isOwner: (c) => c.req.header("x-test-owner") === ownerId,
    integration: { inventory, call, describe: describeActions },
    timeoutMs: options.timeoutMs,
  });
  const queue = (body: unknown = { fileId }, signal?: AbortSignal) => broker.guestRoutes.request("/read", {
    method: "POST", headers: json, body: JSON.stringify(body), signal,
  });
  const state = (includeAccounts = false) => broker.ownerRoutes.request(includeAccounts ? "/?includeAccounts=1" : "/", {
    headers: authenticated,
  });
  async function requestId(): Promise<string> {
    return vi.waitFor(async () => {
      const result = await (await state()).json();
      expect(result.requests).toHaveLength(1);
      return result.requests[0].id;
    });
  }
  const decision = (id: string, body: unknown) => broker.ownerRoutes.request("/" + id + "/decision", {
    method: "POST", headers: authenticated, body: JSON.stringify(body),
  });
  const cancel = (id: string) => broker.ownerRoutes.request("/" + id, { method: "DELETE", headers: authenticated });
  const queueIntegration = (body: unknown = githubRead) => broker.guestRoutes.request("/integration/read", {
    method: "POST", headers: json, body: JSON.stringify(body),
  });
  const integrationState = (includeAccounts = false) => broker.integrationOwnerRoutes.request(includeAccounts ? "/?includeAccounts=1" : "/", {
    headers: authenticated,
  });
  async function integrationRequestId(): Promise<string> {
    return vi.waitFor(async () => {
      const result = await (await integrationState()).json();
      expect(result.requests).toHaveLength(1);
      return result.requests[0].id;
    });
  }
  const integrationDecision = (id: string, body: unknown) => broker.integrationOwnerRoutes.request("/" + id + "/decision", {
    method: "POST", headers: authenticated, body: JSON.stringify(body),
  });
  return { broker, inventory, call, describeActions, queue, state, requestId, decision, cancel,
    queueIntegration, integrationState, integrationRequestId, integrationDecision };
}

describe("Hosted Bots Drive approval", () => {
  it("requires an explicit owner decision for the exact file and selected account", async () => {
    const f = setup();
    try {
      const read = f.queue();
      const id = await f.requestId();
      expect(await (await f.state()).json()).toEqual({
        requests: [{ id, fileId, status: "pending", expiresAt: expect.any(Number) }], accounts: [],
      });
      expect(f.inventory).not.toHaveBeenCalled();
      expect(f.call).not.toHaveBeenCalled();
      expect(await (await f.state(true)).json()).toMatchObject({ accounts: [{ id: accountId, label: "Test Drive" }] });
      expect((await f.broker.ownerRoutes.request("/" + id + "/decision", {
        method: "POST", headers: json, body: JSON.stringify({ decision: "allow", accountId }),
      })).status).toBe(403);
      expect((await f.decision(id, { decision: "allow", accountId })).status).toBe(202);
      expect(await (await read).json()).toEqual({ fileId, name: "Fixture", content: "QA receipt" });
      expect(f.call).toHaveBeenCalledExactlyOnceWith(ownerId, {
        service: "google_drive", action: "read_file", label: "Test Drive", connectionId: accountId,
        params: { fileId }, read: true,
      }, expect.any(AbortSignal));
      expect((await f.decision(id, { decision: "allow", accountId })).status).toBe(404);
    } finally { f.broker.close(); }
  });

  it("rejects extra guest fields, explicit denial, or a disconnected account", async () => {
    const f = setup();
    try {
      expect((await f.queue({ fileId, ownerId, accountId })).status).toBe(400);
      const denied = f.queue();
      expect((await f.decision(await f.requestId(), { decision: "deny" })).status).toBe(202);
      expect((await denied).status).toBe(403);
      const gone = f.queue();
      f.inventory.mockResolvedValueOnce([]);
      expect((await f.decision(await f.requestId(), { decision: "allow", accountId })).status).toBe(202);
      expect((await gone).status).toBe(403);
      expect(f.call).not.toHaveBeenCalled();
    } finally { f.broker.close(); }
  });

  it("revokes an in-flight read and discards even a late successful provider response", async () => {
    const f = setup();
    try {
      const late = Promise.withResolvers<{ data: { fileId: string; name: string; content: string } }>();
      f.call.mockReturnValueOnce(late.promise);
      const read = f.queue();
      const id = await f.requestId();
      expect((await f.decision(id, { decision: "allow", accountId })).status).toBe(202);
      await vi.waitFor(() => expect(f.call).toHaveBeenCalledOnce());
      expect((await f.decision(id, { decision: "allow", accountId })).status).toBe(409);
      expect((await f.cancel(id)).status).toBe(200);
      const denied = await read;
      expect(denied.status).toBe(403);
      late.resolve({ data: { fileId, name: "Fixture", content: "Must not be delivered" } });
      expect(await denied.json()).toEqual({ error: "forbidden" });
      expect(f.call.mock.calls[0]?.[2]?.aborted).toBe(true);
      const again = f.queue();
      expect((await f.cancel(await f.requestId())).status).toBe(200);
      expect((await again).status).toBe(403);
      expect(f.call).toHaveBeenCalledOnce();
    } finally { f.broker.close(); }
  });

  it("expires, cancels disconnected requests and stays closed on non-preview runtimes", async () => {
    const f = setup({ timeoutMs: 20 });
    const abort = new AbortController();
    try {
      expect((await f.queue()).status).toBe(403);
      const pending = f.queue({ fileId }, abort.signal);
      abort.abort();
      expect((await pending).status).toBe(403);
      expect(await (await f.state()).json()).toEqual({ requests: [], accounts: [] });
      expect(f.call).not.toHaveBeenCalled();
      const closed = setup({ admitted: false });
      expect((await closed.queue()).status).toBe(404);
      expect((await closed.state()).status).toBe(404);
      closed.broker.close();
    } finally { f.broker.close(); }
  });

  it("limits concurrent requests and strips unsolicited provider fields", async () => {
    const f = setup();
    try {
      const reads = Array.from({ length: 4 }, () => f.queue());
      const excess = await f.queue();
      expect(excess.status).toBe(429);
      const { requests } = await (await f.state()).json();
      f.call.mockResolvedValueOnce({
        data: { fileId, name: "Fixture", content: "QA", extra: "unused" },
      });
      await f.decision(requests[0].id, { decision: "allow", accountId });
      expect(await (await reads[0]!).json()).toEqual({ fileId, name: "Fixture", content: "QA" });
      f.broker.close();
      expect((await Promise.all(reads.slice(1))).every(r => r.status === 403)).toBe(true);
    } finally { f.broker.close(); }
  });

  it("isolates the guest route to a permissioned Unix socket and cancels on disconnect", async () => {
    const f = setup();
    const directory = await mkdtemp("/tmp/matrix-drive-test-");
    const socket = join(directory, "drive.sock");
    const app = new Hono();
    app.route(HOSTED_BOTS_DRIVE_BASE, f.broker.ownerRoutes);
    let closeSocket: (() => Promise<void>) | undefined;
    try {
      const unsafe = join(directory, "unsafe.sock");
      await symlink("does-not-exist", unsafe);
      await expect(bindHostedBotsDriveSocket(unsafe, f.broker.guestRoutes)).rejects.toThrow("Unexpected Drive socket entry");
      expect((await lstat(unsafe)).isSymbolicLink()).toBe(true);
      closeSocket = await bindHostedBotsDriveSocket(socket, f.broker.guestRoutes);
      expect((await lstat(socket)).mode & 0o777).toBe(0o660);
      await expect(bindHostedBotsDriveSocket(socket, f.broker.guestRoutes)).rejects.toThrow("Drive socket already serving");
      expect((await app.request(HOSTED_BOTS_DRIVE_BASE + "/read", { method: "POST", headers: authenticated,
        body: JSON.stringify({ fileId }) })).status).toBe(404);
      const client = request({ socketPath: socket, path: "/read", method: "POST", headers: { ...json, host: "localhost" } });
      client.on("error", () => { /* Intentionally destroyed before the response. */ });
      client.end(JSON.stringify({ fileId }));
      await f.requestId();
      client.destroy();
      await vi.waitFor(async () => {
        expect(await (await app.request(HOSTED_BOTS_DRIVE_BASE, { headers: authenticated })).json())
          .toEqual({ requests: [], accounts: [] });
      });
      expect(f.call).not.toHaveBeenCalled();
    } finally {
      f.broker.close();
      await closeSocket?.();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("Hosted Bots Pipedream integration approval", () => {
  it("reviews one exact read against a connected GitHub account before dispatch", async () => {
    const f = setup();
    try {
      const data = [{ number: 42, title: "Public sample pull request" }];
      f.call.mockResolvedValueOnce({ data, summary: "Internal summary" });
      const read = f.queueIntegration();
      const id = await f.integrationRequestId();
      expect(await (await f.integrationState()).json()).toEqual({
        requests: [{ id, ...githubRead, expiresAt: expect.any(Number), status: "pending" }], accounts: [],
      });
      expect(f.inventory).not.toHaveBeenCalled();
      expect(f.describeActions).not.toHaveBeenCalled();
      expect(f.call).not.toHaveBeenCalled();
      expect(await (await f.state(true)).json()).toEqual({ requests: [], accounts: [] });
      expect(await (await f.integrationState(true)).json()).toMatchObject({
        accounts: [{ id: githubAccountId, service: "github", label: "Test GitHub" }],
      });
      expect((await f.decision(id, { decision: "allow", accountId })).status).toBe(404);
      expect((await f.broker.integrationOwnerRoutes.request("/" + id + "/decision", {
        method: "POST", headers: json, body: JSON.stringify({ decision: "allow", accountId: githubAccountId }),
      })).status).toBe(403);
      expect((await f.integrationDecision(id, { decision: "allow", accountId: githubAccountId })).status).toBe(202);
      expect(await (await read).json()).toEqual({ data });
      expect(f.describeActions).toHaveBeenCalledExactlyOnceWith(ownerId, { service: "github", readOnly: true }, expect.any(AbortSignal));
      expect(f.call).toHaveBeenCalledExactlyOnceWith(ownerId, {
        ...githubRead, connectionId: githubAccountId, label: "Test GitHub", read: true,
      }, expect.any(AbortSignal));
      expect((await f.integrationDecision(id, { decision: "allow", accountId: githubAccountId })).status).toBe(404);
    } finally { f.broker.close(); }
  });

  it("does not dispatch an unsupported read, invalid params, write, denied request, or wrong-service account", async () => {
    const f = setup();
    try {
      expect((await f.queueIntegration({ ...githubRead, action: "create_issue" })).status).toBe(403);
      expect((await f.queueIntegration({ ...githubRead, service: "constructor" })).status).toBe(403);
      expect((await f.queueIntegration({ ...githubRead, params: { repo: "../oops", per_page: 500 } })).status).toBe(400);
      expect((await f.queueIntegration({ ...githubRead, accountId: githubAccountId })).status).toBe(400);
      expect((await f.queueIntegration({
        service: "linear", action: "viewer", params: { undeclared: true },
      })).status).toBe(400);
      expect((await f.queueIntegration({
        ...githubRead, params: JSON.parse('{"repo":"HamedMP/matrix-os","__proto__":{"unsafe":true}}'),
      })).status).toBe(400);
      const nested = Array.from({ length: 12 }).reduce((value) => ({ nested: value }), {});
      expect((await f.queueIntegration({ ...githubRead, params: { repo: nested } })).status).toBe(400);
      const denied = f.queueIntegration();
      expect((await f.integrationDecision(await f.integrationRequestId(), { decision: "deny" })).status).toBe(202);
      expect(await (await denied).json()).toEqual({ error: "forbidden" });
      const wrong = f.queueIntegration();
      expect((await f.integrationDecision(await f.integrationRequestId(), { decision: "allow", accountId })).status).toBe(202);
      expect((await wrong).status).toBe(403);
      const changed = f.queueIntegration();
      f.describeActions.mockResolvedValueOnce([]);
      await f.integrationDecision(await f.integrationRequestId(), { decision: "allow", accountId: githubAccountId });
      expect((await changed).status).toBe(403);
      expect(f.call).not.toHaveBeenCalled();
    } finally { f.broker.close(); }
  });

  it("bounds request and response size and preserves the legacy Drive response via generic approval", async () => {
    const f = setup();
    try {
      expect((await f.queueIntegration({ ...githubRead, params: { repo: "a".repeat(4096) } })).status).toBe(413);
      f.call.mockResolvedValueOnce({ data: { description: "a".repeat(24 * 1024) } });
      const read = f.queueIntegration();
      await f.integrationDecision(await f.integrationRequestId(), { decision: "allow", accountId: githubAccountId });
      expect((await read).status).toBe(503);
      const legacy = f.queue();
      const id = await f.integrationRequestId();
      expect(await (await f.integrationState()).json()).toMatchObject({
        requests: [{ id, service: "google_drive", action: "read_file", params: { fileId } }],
      });
      await f.integrationDecision(id, { decision: "allow", accountId });
      expect(await (await legacy).json()).toEqual({ fileId, name: "Fixture", content: "QA receipt" });
    } finally { f.broker.close(); }
  });
});

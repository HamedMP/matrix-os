import { expect, it, vi } from "vitest";
import { createNativeAppCollaborationRequester } from "../../desktop/src/main/embeds/native-app-bridge.js";
import { createNativeAppCollaboration } from "../../desktop/src/shared/native-app-collaboration.js";

const appId = "team-tracker";
const endpoint = `https://gateway.test/api/collaboration/apps/${appId}/owner-bridge`;
const participant = {
  actorId: "user_owner", displayName: "Owner", organizationId: "org_matrix_team",
  scopeId: "50000000-0000-4000-8000-000000000001", shareRevision: "1", buildId: "a".repeat(64),
};

it("uses the authenticated scoped owner route for native reads and revisioned writes", async () => {
  const calls: Array<{ url: string; method: string; token: string | null; body: unknown }> = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", token: new Headers(init?.headers).get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : null });
    if (init?.method === "GET") return Response.json({ participant, revision: "4", scopeSequence: "9" });
    const body = JSON.parse(String(init?.body));
    return Response.json("clientRequestId" in body
      ? { result: { ok: true }, revision: 5, replayed: false }
      : { result: [{ id: "task-1" }], revision: "4" });
  });
  const legacyRequest = vi.fn();
  const request = createNativeAppCollaborationRequester({ getGatewayOrigin: () => "https://gateway.test",
    getToken: () => "host-only-token", fetchFn: fetchFn as typeof fetch, legacyRequest });
  await expect(request(appId, { kind: "query", action: { action: "find", table: "tasks" } }))
    .resolves.toEqual({ result: [{ id: "task-1" }], revision: "4" });
  await expect(request(appId, { kind: "mutate", action: { action: "insert", table: "tasks", data: { title: "New" } },
    expectedRevision: "4", clientRequestId: "60000000-0000-4000-8000-000000000001", scopeId: participant.scopeId }))
    .resolves.toEqual({ result: { ok: true }, revision: "5", replayed: false });
  expect(calls).toEqual([
    { url: endpoint, method: "GET", token: "Bearer host-only-token", body: null },
    { url: endpoint, method: "POST", token: "Bearer host-only-token", body: { action: { action: "find", table: "tasks", app: appId } } },
    { url: endpoint, method: "GET", token: "Bearer host-only-token", body: null },
    { url: endpoint, method: "POST", token: "Bearer host-only-token", body: { action: { action: "insert", table: "tasks", data: { title: "New" }, app: appId },
      expectedRevision: "4", clientRequestId: "60000000-0000-4000-8000-000000000001" } },
  ]);
  expect(legacyRequest).not.toHaveBeenCalled();
});

it("fails closed without owner bearer or with a non-app identity", async () => {
  const fetchFn = vi.fn();
  const request = createNativeAppCollaborationRequester({ getGatewayOrigin: () => "https://gateway.test",
    getToken: () => null, fetchFn: fetchFn as typeof fetch, legacyRequest: vi.fn() });
  await expect(request(appId, { kind: "state" })).rejects.toThrow();
  await expect(request("tools/team-tracker", { kind: "state" })).rejects.toThrow();
  expect(fetchFn).not.toHaveBeenCalled();
});

it("never sends an uncertain shared write through legacy storage after sharing stops", async () => {
  let active = true;
  const legacyRequest = vi.fn(async () => ({ id: "duplicate" }));
  const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "GET") return Response.json({ participant: active ? participant : null,
      revision: active ? "4" : "0", scopeSequence: active ? "9" : "0" });
    throw new Error("reply lost after commit");
  });
  const request = createNativeAppCollaborationRequester({ getGatewayOrigin: () => "https://gateway.test",
    getToken: () => "host-only-token", fetchFn: fetchFn as typeof fetch, legacyRequest });
  const mutation = { kind: "mutate" as const, action: { action: "insert", table: "tasks", data: { title: "New" } },
    expectedRevision: "4", clientRequestId: "60000000-0000-4000-8000-000000000001", scopeId: participant.scopeId };
  await expect(request(appId, mutation)).rejects.toThrow();
  active = false;
  await expect(request(appId, mutation)).rejects.toThrow("Collaboration unavailable");
  expect(legacyRequest).not.toHaveBeenCalled();
});

it("notifies the native app from the shared scope sequence and replays uncertain writes with the same id", async () => {
  vi.useFakeTimers();
  try {
    let sequence = "9";
    let failMutation = true;
    const attempts: string[] = [];
    const invoke = vi.fn(async (request) => {
      if (request.kind === "state") return { participant, revision: "4", scopeSequence: sequence };
      if (request.kind === "mutate") {
        attempts.push(request.clientRequestId);
        if (failMutation) throw new Error("transport lost");
        return { result: { ok: true }, revision: "5", replayed: true };
      }
      return { result: [], revision: "4" };
    });
    const api = createNativeAppCollaboration(invoke, participant);
    const changed = vi.fn();
    const off = api.onChange(changed);
    await api.refreshParticipant();
    sequence = "10";
    await vi.advanceTimersByTimeAsync(2_000);
    expect(changed).toHaveBeenCalledTimes(1);
    await expect(api.mutate({ action: "insert", table: "tasks", data: { title: "New" } }, "4"))
      .rejects.toThrow("transport lost");
    failMutation = false;
    await expect(api.retryMutation()).resolves.toEqual({ result: { ok: true }, revision: "5", replayed: true });
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toBe(attempts[1]);
    off();
  } finally { vi.useRealTimers(); }
});

it("reserves all retry slots before sending and refuses an untrackable write", async () => {
  let sent = 0;
  const invoke = vi.fn(async (request) => {
    if (request.kind === "state") return { participant, revision: "4", scopeSequence: "9" };
    if (request.kind === "mutate") { sent++; throw new Error("reply lost"); }
  });
  const api = createNativeAppCollaboration(invoke, participant);
  for (let index = 0; index < 32; index++) {
    await expect(api.mutate({ action: "insert", table: "tasks", data: { title: String(index) } }, "4"))
      .rejects.toThrow("reply lost");
  }
  await expect(api.mutate({ action: "insert", table: "tasks", data: { title: "overflow" } }, "4"))
    .rejects.toThrow("Collaboration unavailable");
  expect(sent).toBe(32);
});

it("discards a definite conflict and recovers a later uncertain write", async () => {
  const attempts: string[] = [];
  let phase = "initial";
  const invoke = vi.fn(async (request) => {
    if (request.kind === "state") return { participant, revision: "4", scopeSequence: "9" };
    if (request.kind === "mutate") {
      attempts.push(request.clientRequestId);
      if (phase === "initial") throw new Error("reply lost");
      if (attempts[0] === request.clientRequestId) throw Object.assign(new Error("Collaboration conflict"), { code: "conflict" });
      return { result: { ok: true }, revision: "5", replayed: true };
    }
  });
  const api = createNativeAppCollaboration(invoke, participant);
  await expect(api.mutate({ action: "insert", table: "tasks", data: { title: "old" } }, "4")).rejects.toThrow();
  await expect(api.mutate({ action: "insert", table: "tasks", data: { title: "saved" } }, "4")).rejects.toThrow();
  phase = "recovery";
  await expect(api.retryMutation()).resolves.toEqual({ result: { ok: true }, revision: "5", replayed: true });
  expect(attempts[1]).toBe(attempts[3]);
});

it("preserves only safe conflict codes from gateway failures", async () => {
  const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => init?.method === "GET"
    ? Response.json({ participant, revision: "4", scopeSequence: "9" })
    : Response.json({ error: "private details", code: "conflict" }, { status: 409 }));
  const request = createNativeAppCollaborationRequester({ getGatewayOrigin: () => "https://gateway.test",
    getToken: () => "host-only-token", fetchFn: fetchFn as typeof fetch, legacyRequest: vi.fn() });
  await expect(request(appId, { kind: "mutate", action: { action: "insert", table: "tasks", data: {} },
    expectedRevision: "4", clientRequestId: "60000000-0000-4000-8000-000000000001", scopeId: participant.scopeId }))
    .rejects.toMatchObject({ code: "conflict" });
});

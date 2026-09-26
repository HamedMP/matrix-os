import { describe, expect, it, vi } from "vitest";
import { createJevRecipeReadClient } from "../../packages/gateway/src/jev/recipe-read-client.js";
import { INTEGRATION_READ_SCOPE_HEADER } from "../../packages/gateway/src/integrations/scope-provenance.js";
import type { HermesJevScope } from "../../packages/gateway/src/chat/hermes-integration-capability.js";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";
const scope: HermesJevScope = { kind: "jev_inbox_preview", runId: "run_fixture", agentId: "bot_jevone01", revision: 1,
  account: { service: "gmail", accountLabel: "My Gmail", connectionId: "conn_fixture", expectedEmail: "me@example.test" } };
const baseUrl = "https://platform.example.test/internal/containers/fixture/integrations";
describe("production recipe reads use existing owner-delegated Platform transport", () => {
  it("uses configured local dependencies only when the Platform proxy is absent", async () => {
    const row = { id: "conn_fixture", user_id: "owner_fixture", service: "gmail", status: "active", account_label: "My Gmail",
      account_email: "me@example.test", pipedream_account_id: "apn_fixture" };
    const db = { listConnectedServices: vi.fn(async () => [row]), getUserById: vi.fn(async () => ({ pipedream_external_id: "pd_fixture" })) };
    const get = vi.fn(async () => ({ emailAddress: "me@example.test" }));
    const fetcher = vi.fn();
    const read = createJevRecipeReadClient({ internalBaseUrl: null, db: db as unknown as PlatformDb,
      pipedream: { boundedGmailGet: get } as unknown as PipedreamConnectClient, fetcher });
    await expect(read("owner_fixture", scope, "get_profile")).resolves.toEqual({ emailAddress: "me@example.test" });
    expect(db.listConnectedServices).toHaveBeenCalledWith("owner_fixture"); expect(fetcher).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledWith({ kind: "profile", externalUserId: "pd_fixture", accountId: "apn_fixture" }, expect.any(AbortSignal));
  });
  it("does not fall back to local account access when an available Platform proxy fails", async () => {
    const listConnectedServices = vi.fn();
    const read = createJevRecipeReadClient({ internalBaseUrl: baseUrl, machineToken: "fixture", db: { listConnectedServices } as unknown as PlatformDb,
      fetcher: async () => new Response(null, { status: 503 }) });
    await expect(read("owner_fixture", scope, "get_profile")).rejects.toThrow();
    expect(listConnectedServices).not.toHaveBeenCalled();
  });
  it("pins route/action/owner/account without exposing machine bearer to model", async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ service: "gmail", action: "get_profile", data: { emailAddress: "me@example.test" } }));
    const read = createJevRecipeReadClient({ internalBaseUrl: baseUrl, machineToken: "fixture-machine-token", fetcher });
    await expect(read("owner_fixture", scope, "get_profile")).resolves.toEqual({ emailAddress: "me@example.test" });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/read-call`); expect(init.method).toBe("POST"); expect(init.redirect).toBe("error");
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer fixture-machine-token");
    expect(headers.get(INTEGRATION_READ_SCOPE_HEADER)).toBe("read");
    expect(headers.get("x-platform-user-id")).toBe("owner_fixture"); expect(headers.get("x-platform-verified")).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(String(init.body))).toEqual({ service: "gmail", action: "get_profile", label: "My Gmail", params: {}, binding: scope.account });
  });
  it.each(["write", "url", "foreign-id", "missing-config", "pre-abort"])("denies %s before physical transport", async (mode) => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ service: "gmail", action: "get_profile", data: {} }));
    const read = createJevRecipeReadClient({ internalBaseUrl: mode === "missing-config" ? null : baseUrl, machineToken: "fixture", fetcher });
    const controller = new AbortController(); if (mode === "pre-abort") controller.abort();
    await expect(read("owner_fixture", scope, mode === "write" ? "send_email" : mode === "foreign-id" ? "get_message" : "get_profile",
      mode === "url" ? { url: "https://other.test" } : mode === "foreign-id" ? { messageId: "../other" } : {}, controller.signal)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["status", "declared-overflow", "streamed-overflow", "invalid-envelope"])("fails closed on %s and cancels rejected body", async (mode) => {
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("x".repeat(193 * 1024))); }, cancel: cancelled });
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => mode === "invalid-envelope" ? Response.json({ data: {} })
      : new Response(stream, { status: mode === "status" ? 403 : 200,
        headers: mode === "declared-overflow" ? { "content-length": String(193 * 1024) } : undefined }));
    const read = createJevRecipeReadClient({ internalBaseUrl: baseUrl, machineToken: "fixture", fetcher });
    await expect(read("owner_fixture", scope, "get_profile")).rejects.toThrow();
    if (mode !== "invalid-envelope") expect(cancelled).toHaveBeenCalledTimes(1);
  });
});

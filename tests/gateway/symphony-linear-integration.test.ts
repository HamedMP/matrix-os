import { describe, expect, it, vi } from "vitest";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";
import { encodeLinearIntegrationCredential } from "../../packages/gateway/src/symphony/credential-store.js";
import {
  createInternalProxyLinearGraphql,
  createIntegrationAwareLinearGraphql,
  hasConnectedLinearIntegration,
  hasConnectedLinearIntegrationViaInternalProxy,
} from "../../packages/gateway/src/symphony/linear-integration.js";

const linearConnection = {
  id: "svc_1",
  user_id: "user_123",
  service: "linear",
  pipedream_account_id: "pd_acc_123",
  account_label: "Linear",
  account_email: null,
  scopes: [],
  status: "active" as const,
  connected_at: new Date("2026-05-13T00:00:00.000Z"),
  last_used_at: null,
};

describe("Symphony Linear integration transport", () => {
  it("detects an active connected Linear integration", async () => {
    const db = {
      listConnectedServices: vi.fn(async () => [linearConnection]),
    } as unknown as PlatformDb;

    await expect(hasConnectedLinearIntegration(db, "user_123")).resolves.toBe(true);
    expect(db.listConnectedServices).toHaveBeenCalledWith("user_123");
  });

  it("executes integration credentials through Pipedream without exposing provider tokens", async () => {
    const db = {
      listConnectedServices: vi.fn(async () => [linearConnection]),
      getUserById: vi.fn(async () => ({ id: "user_123", pipedream_external_id: null })),
      updatePipedreamExternalId: vi.fn(async () => undefined),
      touchServiceUsage: vi.fn(async () => undefined),
    } as unknown as PlatformDb;
    const pipedream = {
      proxyPost: vi.fn(async () => ({ data: { viewer: { id: "viewer_1" } } })),
    } as unknown as PipedreamConnectClient;
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const transport = createIntegrationAwareLinearGraphql({ platformDb: db, pipedream });

    const result = await transport({
      credential: encodeLinearIntegrationCredential("user_123"),
      query: "query Test($first: Int!) { viewer { id } }",
      variables: { first: 1 },
      endpoint: "https://api.linear.app/graphql",
      fetch: fetchMock,
      timeoutMs: 10_000,
    });

    expect(result).toEqual({ data: { viewer: { id: "viewer_1" } } });
    expect(pipedream.proxyPost).toHaveBeenCalledWith({
      externalUserId: "user_123",
      accountId: "pd_acc_123",
      url: "https://api.linear.app/graphql",
      body: {
        query: "query Test($first: Int!) { viewer { id } }",
        variables: { first: 1 },
      },
    });
    expect(db.updatePipedreamExternalId).toHaveBeenCalledWith("user_123", "user_123");
    expect(db.touchServiceUsage).toHaveBeenCalledWith("svc_1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes Pipedream proxy failures for integration-backed GraphQL", async () => {
    const db = {
      listConnectedServices: vi.fn(async () => [linearConnection]),
      getUserById: vi.fn(async () => ({ id: "user_123", pipedream_external_id: "ext_123" })),
      updatePipedreamExternalId: vi.fn(async () => undefined),
      touchServiceUsage: vi.fn(async () => undefined),
    } as unknown as PlatformDb;
    const pipedream = {
      proxyPost: vi.fn(async () => {
        throw new Error("provider timeout with raw details");
      }),
    } as unknown as PipedreamConnectClient;
    const transport = createIntegrationAwareLinearGraphql({ platformDb: db, pipedream });

    await expect(transport({
      credential: encodeLinearIntegrationCredential("user_123"),
      query: "query Test { viewer { id } }",
      endpoint: "https://api.linear.app/graphql",
      fetch: vi.fn() as unknown as typeof fetch,
      timeoutMs: 10_000,
    })).rejects.toThrow("linear_integration_unavailable");
    expect(db.touchServiceUsage).not.toHaveBeenCalled();
  });

  it("detects connected Linear through the customer VPS integration proxy", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      { service: "gmail" },
      { service: "linear" },
    ]), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(hasConnectedLinearIntegrationViaInternalProxy({
      baseUrl: "https://platform.example/internal/containers/alice/integrations",
      token: "upgrade-token",
      fetch: fetchMock as unknown as typeof fetch,
    })).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://platform.example/internal/containers/alice/integrations",
      expect.objectContaining({
        method: "GET",
        headers: expect.any(Headers),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("executes integration credentials through the customer VPS integration proxy", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: { data: { viewer: { id: "viewer_1" } } },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const transport = createInternalProxyLinearGraphql({
      baseUrl: "https://platform.example/internal/containers/alice/integrations",
      token: "upgrade-token",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await transport({
      credential: encodeLinearIntegrationCredential("user_123"),
      query: "query Test($first: Int!) { viewer { id } }",
      variables: { first: 1 },
      endpoint: "https://api.linear.app/graphql",
      fetch: vi.fn() as unknown as typeof fetch,
      timeoutMs: 10_000,
    });

    expect(result).toEqual({ data: { viewer: { id: "viewer_1" } } });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://platform.example/internal/containers/alice/integrations/call",
      expect.objectContaining({
        method: "POST",
        headers: expect.any(Headers),
        body: JSON.stringify({
          service: "linear",
          action: "graphql",
          params: {
            query: "query Test($first: Int!) { viewer { id } }",
            variables: { first: 1 },
          },
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });
});

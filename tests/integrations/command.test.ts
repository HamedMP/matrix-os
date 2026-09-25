import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

import { runIntegrationsCommand } from "../../packages/integrations-mcp/dist/command.js";
import type { GatewayFetcher } from "../../packages/kernel/src/tools/integrations.js";

function response(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  };
}

describe("matrix-integrations terminal fallback", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("preserves run-scoped authority for read-only calls", async () => {
    const scopedToken = "a".repeat(64);
    vi.stubEnv("MATRIX_AGENT_INTEGRATIONS_TOKEN", scopedToken);
    vi.stubEnv("MATRIX_AUTH_TOKEN", "legacy-host-token");
    vi.stubEnv("MATRIX_CLERK_USER_ID", "host_owner");
    const fetcher = vi.fn<GatewayFetcher>()
      .mockResolvedValueOnce(response([{ id: "gmail", actions: { list_messages: { risk: "read" } } }]))
      .mockResolvedValueOnce(response({ messages: [] }));

    await runIntegrationsCommand(
      ["call", "gmail", "list_messages", "{}", "Work Gmail"],
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [, options] of fetcher.mock.calls) {
      expect(options?.headers).toMatchObject({ Authorization: `Bearer ${scopedToken}` });
      expect(options?.headers).not.toHaveProperty("x-platform-user-id");
      expect(options?.headers).not.toHaveProperty("x-platform-verified");
    }
  });

  it.each(["", " ", "not-a-scoped-token"])("fails closed on malformed scoped token %j even with host credentials", async (scopedToken) => {
    vi.stubEnv("MATRIX_AGENT_INTEGRATIONS_TOKEN", scopedToken);
    vi.stubEnv("MATRIX_AUTH_TOKEN", "legacy-host-token");
    vi.stubEnv("MATRIX_CLERK_USER_ID", "host_owner");
    const fetcher = vi.fn<GatewayFetcher>();

    await expect(runIntegrationsCommand(
      ["call", "gmail", "list_messages", "{}", "Work Gmail"],
      fetcher,
    )).rejects.toThrow("InvalidAgentIntegrationCapability");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves guarded legacy host authority when no scoped token is present", async () => {
    const hostToken = "legacy-host-token";
    const ownerId = "host_owner";
    vi.stubEnv("MATRIX_AGENT_INTEGRATIONS_TOKEN", undefined);
    vi.stubEnv("MATRIX_AUTH_TOKEN", hostToken);
    vi.stubEnv("MATRIX_CLERK_USER_ID", ownerId);
    vi.stubEnv("MATRIX_AGENT_OWNER_ID", undefined);
    vi.stubEnv("MATRIX_AGENT_OWNER_PROOF", undefined);
    const fetcher = vi.fn<GatewayFetcher>()
      .mockResolvedValueOnce(response([{ id: "gmail", actions: { list_messages: { risk: "read" } } }]))
      .mockResolvedValueOnce(response({ messages: [] }));

    await runIntegrationsCommand(
      ["call", "gmail", "list_messages", "{}", "Work Gmail"],
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [, options] of fetcher.mock.calls) {
      expect(options?.headers).toMatchObject({
        Authorization: `Bearer ${hostToken}`,
        "x-platform-user-id": ownerId,
        "x-platform-verified": createHmac("sha256", hostToken).update(ownerId).digest("hex"),
      });
    }
  });

  it("rejects legacy agent delegation without a scoped token", async () => {
    vi.stubEnv("MATRIX_AGENT_INTEGRATIONS_TOKEN", undefined);
    vi.stubEnv("MATRIX_AUTH_TOKEN", "legacy-host-token");
    vi.stubEnv("MATRIX_CLERK_USER_ID", "host_owner");
    vi.stubEnv("MATRIX_AGENT_OWNER_ID", "different_owner");
    const fetcher = vi.fn<GatewayFetcher>();

    await expect(runIntegrationsCommand(
      ["call", "gmail", "list_messages", "{}", "Work Gmail"],
      fetcher,
    )).rejects.toThrow("LegacyAgentDelegationRejected");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["write", "send_email"],
    ["unknown", "future_action"],
  ])("rejects a scoped %s action after catalog lookup", async (risk, action) => {
    vi.stubEnv("MATRIX_AGENT_INTEGRATIONS_TOKEN", "a".repeat(64));
    const fetcher = vi.fn<GatewayFetcher>().mockResolvedValue(
      response([{ id: "gmail", actions: { [action]: { risk } } }]),
    );

    await expect(runIntegrationsCommand(
      ["call", "gmail", action, "{}", "Work Gmail"],
      fetcher,
    )).rejects.toThrow(/read-only/i);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a scoped call without an exact account label before catalog lookup", async () => {
    vi.stubEnv("MATRIX_AGENT_INTEGRATIONS_TOKEN", "a".repeat(64));
    const fetcher = vi.fn<GatewayFetcher>();

    await expect(runIntegrationsCommand(
      ["call", "gmail", "list_messages", "{}"],
      fetcher,
    )).rejects.toThrow(/account label/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("calls a read action only for the selected account", async () => {
    const fetcher = vi.fn<GatewayFetcher>()
      .mockResolvedValueOnce(response([{ id: "gmail", actions: { list_messages: { risk: "read" } } }]))
      .mockResolvedValueOnce(response({ messages: [{ id: "m1" }] }));

    const output = await runIntegrationsCommand(
      ["call", "gmail", "list_messages", '{"maxResults":5}', "Work Gmail"],
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/integrations/agent-catalog",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/integrations/call",
      expect.objectContaining({ method: "POST", body: expect.stringContaining('"label":"Work Gmail"') }),
    );
    expect(output).toContain('"m1"');
  });

  it("rejects calls without an exact account label", async () => {
    const fetcher = vi.fn<GatewayFetcher>();
    await expect(runIntegrationsCommand(["call", "gmail", "list_messages", "{}"], fetcher))
      .rejects.toThrow(/account label/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["write", "destructive", "unknown"])("rejects %s actions before execution", async (risk) => {
    const fetcher = vi.fn<GatewayFetcher>().mockResolvedValue(
      response([{ id: "gmail", actions: { send_email: { risk } } }]),
    );
    await expect(runIntegrationsCommand(["call", "gmail", "send_email", "{}", "Work Gmail"], fetcher))
      .rejects.toThrow(/read-only/i);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fails closed when action discovery is unavailable", async () => {
    const fetcher = vi.fn<GatewayFetcher>().mockResolvedValue({ ...response({}), ok: false, status: 503 });
    await expect(runIntegrationsCommand(["call", "gmail", "list_messages", "{}", "Work Gmail"], fetcher))
      .rejects.toThrow(/read-only/i);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not report a failed provider call as a successful read", async () => {
    const fetcher = vi.fn<GatewayFetcher>()
      .mockResolvedValueOnce(response([{ id: "granola", actions: { list_notes: { risk: "read" } } }]))
      .mockResolvedValueOnce({ ...response({ error: "upstream unavailable" }), ok: false, status: 502 });
    await expect(runIntegrationsCommand(["call", "granola", "list_notes", "{}", "Granola"], fetcher))
      .rejects.toThrow("Integration call failed");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects unknown commands before making a gateway request", async () => {
    const fetcher = vi.fn<GatewayFetcher>();

    await expect(runIntegrationsCommand(["arbitrary"], fetcher)).rejects.toThrow("Usage:");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

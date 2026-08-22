import { describe, expect, it, vi } from "vitest";

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
  it("lets skill-aware agents call the same approved gateway action", async () => {
    const fetcher = vi.fn<GatewayFetcher>().mockResolvedValue(response({ messages: [{ id: "m1" }] }));

    const output = await runIntegrationsCommand(
      ["call", "gmail", "list_messages", '{"maxResults":5}'],
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/integrations/call",
      expect.objectContaining({ method: "POST" }),
    );
    expect(output).toContain('"m1"');
  });

  it("rejects unknown commands before making a gateway request", async () => {
    const fetcher = vi.fn<GatewayFetcher>();

    await expect(runIntegrationsCommand(["arbitrary"], fetcher)).rejects.toThrow("Usage:");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

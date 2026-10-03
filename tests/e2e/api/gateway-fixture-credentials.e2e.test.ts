import { describe, expect, it, vi } from "vitest";
import { startTestGateway } from "../fixtures/gateway.js";

const message = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "synthetic fixture dispatch" }) };

describe("E2E: Mock kernel owner credentials", () => {
  it("dispatches only through an explicit synthetic owner key to the injected kernel", async () => {
    let observedKey: string | undefined;
    const gateway = await startTestGateway({
      mockOwnerCredentials: true,
      spawnFn: async function* (_message, config) {
        observedKey = config.env?.ANTHROPIC_API_KEY;
        yield { type: "result", data: { sessionId: "fixture-owner", cost: 0, tokensIn: 0, tokensOut: 0, turns: 1 } };
      },
    });
    try {
      expect((await gateway.request("/api/message", message)).status).toBe(200);
      expect(observedKey).toBe("synthetic-e2e-owner-key");
    } finally {
      await gateway.close();
    }
  });

  it("keeps credential-free dispatch fail closed even with an injected kernel", async () => {
    const spawnFn = vi.fn(async function* () {
      yield { type: "result", data: { sessionId: "must-not-run", cost: 0, tokensIn: 0, tokensOut: 0, turns: 1 } } as const;
    });
    const gateway = await startTestGateway({ spawnFn });
    try {
      expect((await gateway.request("/api/message", message)).status).toBe(500);
      expect(spawnFn).not.toHaveBeenCalled();
    } finally {
      await gateway.close();
    }
  });

  it("rejects synthetic credentials when a real kernel would run", async () => {
    await expect(startTestGateway({ mockOwnerCredentials: true })).rejects.toThrow("Mock owner credentials require an injected kernel");
  });
});

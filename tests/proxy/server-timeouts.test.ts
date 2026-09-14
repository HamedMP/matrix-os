import { describe, expect, it } from "vitest";
import { configureProxyServerTimeouts } from "../../packages/proxy/src/server-timeouts.js";

describe("proxy server timeouts", () => {
  it("sets explicit inbound header and request-body deadlines", () => {
    const server = { headersTimeout: 0, requestTimeout: 0 };

    configureProxyServerTimeouts(server);

    expect(server.headersTimeout).toBe(10_000);
    expect(server.requestTimeout).toBe(10_000);
  });
});

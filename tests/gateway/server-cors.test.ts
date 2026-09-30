import { describe, expect, it } from "vitest";
import { buildAllowedOrigins, createAllowedOriginController } from "../../packages/gateway/src/allowed-origins.js";

describe("gateway CORS origins", () => {
  it("allows only configured and gateway-owned origins", () => {
    expect(buildAllowedOrigins({
      shellOrigin: "http://shell.local",
      proxyOrigin: "http://proxy.local",
    })).toEqual([
      "http://shell.local",
      "http://proxy.local",
      "http://localhost:3000",
      "http://localhost:4001",
    ]);
  });

  it("does not allow the retired dashboard origin", () => {
    const controller = createAllowedOriginController({ shellOrigin: "http://shell.local" });
    expect(controller.resolve("http://shell.local")).toBe("http://shell.local");
    expect(controller.resolve("http://127.0.0.1:4766")).toBeUndefined();
  });
});

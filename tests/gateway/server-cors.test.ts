import { describe, expect, it } from "vitest";
import { buildAllowedOrigins } from "../../packages/gateway/src/server.js";

describe("gateway CORS origins", () => {
  it("includes the configured Symphony runner port without duplicating defaults", () => {
    expect(buildAllowedOrigins({
      shellOrigin: "http://shell.local",
      proxyOrigin: "http://proxy.local",
      symphonyPort: 4088,
    })).toEqual([
      "http://shell.local",
      "http://proxy.local",
      "http://localhost:3000",
      "http://localhost:4001",
      "http://localhost:4066",
      "http://localhost:4088",
    ]);

    expect(buildAllowedOrigins({ symphonyPort: 4066 }).filter((origin) => origin === "http://localhost:4066")).toHaveLength(1);
  });
});

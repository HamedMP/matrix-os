import { describe, expect, it } from "vitest";
import { buildAllowedOrigins, createAllowedOriginController } from "../../packages/gateway/src/server.js";

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
      "http://127.0.0.1:4066",
      "http://localhost:4088",
      "http://127.0.0.1:4088",
    ]);

    expect(buildAllowedOrigins({ symphonyPort: 4066 }).filter((origin) => origin === "http://localhost:4066")).toHaveLength(1);
    expect(buildAllowedOrigins({ symphonyPort: 4066 }).filter((origin) => origin === "http://127.0.0.1:4066")).toHaveLength(1);
  });

  it("updates the Symphony dashboard origin when the runner port changes", () => {
    const controller = createAllowedOriginController({ symphonyPort: 4066 });

    expect(controller.resolve("http://127.0.0.1:4088")).toBeUndefined();
    controller.updateSymphonyPort(4088);

    expect(controller.resolve("http://127.0.0.1:4088")).toBe("http://127.0.0.1:4088");
    expect(controller.resolve("http://localhost:4088")).toBe("http://localhost:4088");
  });
});

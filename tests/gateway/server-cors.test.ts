import { describe, expect, it } from "vitest";
import { SymphonyConfigLoadError } from "../../packages/gateway/src/symphony-runner.js";
import { buildAllowedOrigins, createAllowedOriginController, readInitialSymphonyPort, resolveInitialSymphonyPort } from "../../packages/gateway/src/server.js";

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
      "http://localhost:4766",
      "http://127.0.0.1:4766",
      "http://localhost:4088",
      "http://127.0.0.1:4088",
    ]);

    expect(buildAllowedOrigins({ symphonyPort: 4766 }).filter((origin) => origin === "http://localhost:4766")).toHaveLength(1);
    expect(buildAllowedOrigins({ symphonyPort: 4766 }).filter((origin) => origin === "http://127.0.0.1:4766")).toHaveLength(1);
  });

  it("updates the Symphony dashboard origin when the runner port changes", () => {
    const controller = createAllowedOriginController({ symphonyPort: 4077 });

    expect(controller.resolve("http://127.0.0.1:4088")).toBeUndefined();
    expect(controller.resolve("http://127.0.0.1:4077")).toBe("http://127.0.0.1:4077");
    controller.updateSymphonyPort(4088, [4077]);

    expect(controller.resolve("http://127.0.0.1:4088")).toBe("http://127.0.0.1:4088");
    expect(controller.resolve("http://localhost:4088")).toBe("http://localhost:4088");
    expect(controller.resolve("http://127.0.0.1:4077")).toBe("http://127.0.0.1:4077");

    controller.updateSymphonyPort(4088);

    expect(controller.resolve("http://127.0.0.1:4077")).toBeUndefined();
  });

  it("does not require readable Symphony config to seed gateway CORS", async () => {
    await expect(readInitialSymphonyPort({
      getConfig: async () => {
        throw new SymphonyConfigLoadError();
      },
    })).resolves.toBeUndefined();
  });

  it("prefers explicit Symphony service environment over stored config", async () => {
    await expect(resolveInitialSymphonyPort({
      getConfig: async () => ({ port: 4777 }) as never,
    }, {
      SYMPHONY_PORT: "4888",
    })).resolves.toBe(4888);

    await expect(resolveInitialSymphonyPort({
      getConfig: async () => ({ port: 4777 }) as never,
    }, {
      SYMPHONY_UPSTREAM_ORIGIN: "http://127.0.0.1:4999",
      SYMPHONY_PORT: "4888",
    })).resolves.toBe(4999);
  });
});

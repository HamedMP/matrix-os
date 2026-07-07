import { describe, expect, it } from "vitest";
import { SymphonyConfigLoadError } from "../../packages/gateway/src/symphony-runner.js";
import {
  readInitialSymphonyPort,
  resolveInitialSymphonyPort,
  symphonyUpstreamOriginForPort,
} from "../../packages/gateway/src/server/symphony-origin.js";

describe("gateway Symphony origin helpers", () => {
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

  it("rejects invalid upstream origins and formats loopback origins", async () => {
    await expect(resolveInitialSymphonyPort({
      getConfig: async () => ({ port: 4777 }) as never,
    }, {
      SYMPHONY_UPSTREAM_ORIGIN: "https://127.0.0.1:4999",
      SYMPHONY_PORT: "4888",
    })).resolves.toBe(4888);

    expect(symphonyUpstreamOriginForPort(undefined)).toBeUndefined();
    expect(symphonyUpstreamOriginForPort(4999)).toBe("http://127.0.0.1:4999");
  });
});

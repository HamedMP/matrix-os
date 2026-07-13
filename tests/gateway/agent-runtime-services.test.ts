import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHermesAgentRuntimeServices,
} from "../../packages/gateway/src/agent-config/runtime-services.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("Hermes agent runtime services", () => {
  it("wires a catalog-backed model mutation through to owner config", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "agent-runtime-services-"));
    cleanupPaths.push(homePath);
    await mkdir(join(homePath, "system"), { recursive: true });
    await writeFile(join(homePath, "system/config.json"), "{}");
    let model = "hermes-3";
    const readJson = vi.fn(async (path: string) => path === "/api/status"
      ? { gateway_running: true }
      : {
          provider: "nous",
          model,
          providers: [{
            slug: "nous",
            name: "Nous",
            authenticated: true,
            auth_type: "oauth",
            models: ["hermes-3", "hermes-4-405b"],
          }],
        });
    const requestJson = vi.fn(async () => {
      model = "hermes-4-405b";
      return { ok: true };
    });
    const services = createHermesAgentRuntimeServices({
      homePath,
      client: { readJson, requestJson },
    });

    await expect(services.controller.update({
      provider: "nous",
      messagingModel: "hermes-4-405b",
      revision: 0,
    })).resolves.toMatchObject({
      runtime: "hermes",
      revision: 1,
      selection: { provider: "nous", model: "hermes-4-405b" },
    });

    expect(requestJson).toHaveBeenCalledWith(
      "/api/model/set",
      expect.objectContaining({ method: "POST" }),
      expect.any(AbortSignal),
    );
    await expect(readFile(join(homePath, "system/config.json"), "utf8"))
      .resolves.toContain('"revision": 1');
    await services.controller.close();
  });
});

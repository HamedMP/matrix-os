import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createPlatformSpeechHostConfigRoutes } from "../../packages/gateway/src/speech/host-activation.js";

const token = "upgrade-token-that-is-long-enough";
const baseEnv = {
  UPGRADE_TOKEN: token,
  PLATFORM_INTERNAL_URL: "https://app.matrix-os.com",
  MATRIX_MACHINE_ID: "machine-1",
  MATRIX_RUNTIME_SLOT: "primary",
  MATRIX_PLATFORM_SPEECH_ENABLED: "false",
  MATRIX_PLATFORM_SPEECH_ORIGIN: "",
  MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN: "",
} as NodeJS.ProcessEnv;
const config = {
  machineId: "machine-1",
  runtimeSlot: "primary",
  enabled: true,
  origin: "https://app.matrix-os.com",
  runtimeToken: "a".repeat(64),
};
const configurationRevision = createHash("sha256")
  .update(`${config.machineId}\0${config.runtimeSlot}\0${config.origin}\0${config.runtimeToken}`)
  .digest("hex");

describe("gateway platform speech host activation", () => {
  it("requires the host's independent upgrade bearer", async () => {
    const applyConfig = vi.fn();
    const app = createPlatformSpeechHostConfigRoutes({ env: { ...baseEnv }, applyConfig });
    const response = await app.request("/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    });
    expect(response.status).toBe(401);
    expect(applyConfig).not.toHaveBeenCalled();
  });

  it("binds activation to the exact host identity and platform origin", async () => {
    const applyConfig = vi.fn();
    const app = createPlatformSpeechHostConfigRoutes({ env: { ...baseEnv }, applyConfig });
    for (const body of [
      { ...config, machineId: "machine-2" },
      { ...config, runtimeSlot: "secondary" },
      { ...config, origin: "https://other.example.com" },
      { ...config, runtimeToken: "secret response body" },
    ]) {
      const response = await app.request("/config", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid request" });
    }
    expect(applyConfig).not.toHaveBeenCalled();
  });

  it("applies valid configuration, schedules restart, and verifies only after reload", async () => {
    const env = { ...baseEnv };
    const applyConfig = vi.fn().mockResolvedValue(undefined);
    const scheduleRestart = vi.fn().mockResolvedValue(undefined);
    const app = createPlatformSpeechHostConfigRoutes({ env, applyConfig, scheduleRestart });
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const response = await app.request("/config", {
      method: "POST",
      headers,
      body: JSON.stringify(config),
    });
    expect(response.status).toBe(202);
    expect(applyConfig).toHaveBeenCalledWith(config);
    expect(scheduleRestart).toHaveBeenCalledOnce();
    expect(await (await app.request("/config", { headers })).json()).toEqual({
      configured: false,
      configurationRevision: null,
    });

    env.MATRIX_PLATFORM_SPEECH_ENABLED = "true";
    env.MATRIX_PLATFORM_SPEECH_ORIGIN = config.origin;
    env.MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN = config.runtimeToken;
    expect(await (await app.request("/config", { headers })).json()).toEqual({
      configured: true,
      configurationRevision,
    });
    const idempotent = await app.request("/config", {
      method: "POST",
      headers,
      body: JSON.stringify(config),
    });
    expect(idempotent.status).toBe(200);
    expect(applyConfig).toHaveBeenCalledOnce();
    expect(scheduleRestart).toHaveBeenCalledOnce();
  });
});

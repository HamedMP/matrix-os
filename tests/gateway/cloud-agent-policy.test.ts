import { describe, expect, it } from "vitest";
import {
  assertCloudAgentRuntime,
  createGatewayDesktopRuntimePolicy,
} from "../../packages/gateway/src/desktop/runtime-policy.js";

describe("cloud-only agent policy", () => {
  it("allows only cloud agent execution in desktop-visible runtime policy", () => {
    const policy = createGatewayDesktopRuntimePolicy({
      shellUrl: "http://localhost:3000/",
      gatewayUrl: "http://localhost:4000/",
      version: "0.9.0",
    });

    expect(policy.agentExecution).toEqual({ mode: "cloud", localAgentsAllowed: false });
    expect(policy.capabilities).toEqual(expect.arrayContaining(["cloudDevelopment", "symphonyRunner"]));
    expect(JSON.stringify(policy)).not.toMatch(/token|secret|key|\/Users\//i);
  });

  it("rejects local runtime probes with a generic policy error", () => {
    expect(() => assertCloudAgentRuntime({ mode: "cloud" })).not.toThrow();
    expect(() => assertCloudAgentRuntime({ mode: "local" })).toThrow("Cloud agent runtime required");
    expect(() => assertCloudAgentRuntime({ mode: "desktop" })).toThrow("Cloud agent runtime required");
  });
});

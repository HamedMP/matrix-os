import { describe, expect, it } from "vitest";
import {
  createDesktopRuntimePolicy,
  parseMatrixDesktopConfig,
} from "../../apps/desktop/src/main/config.js";

describe("desktop runtime policy", () => {
  it("normalizes a Matrix shell target while keeping coding agents cloud-only", () => {
    const config = parseMatrixDesktopConfig({
      MATRIX_DESKTOP_SHELL_URL: "http://localhost:3000/",
      MATRIX_DESKTOP_GATEWAY_URL: "http://localhost:4000/",
    });

    const policy = createDesktopRuntimePolicy(config);

    expect(policy.instance.shellUrl).toBe("http://localhost:3000/");
    expect(policy.instance.gatewayUrl).toBe("http://localhost:4000/");
    expect(policy.gatewayHealth).toBe("healthy");
    expect(policy.agentExecution).toEqual({ mode: "cloud", localAgentsAllowed: false });
    expect(policy.capabilities).toEqual(
      expect.arrayContaining([
        "matrixShell",
        "appLauncher",
        "cloudDevelopment",
        "linearTicketSync",
        "internalTickets",
        "symphonyRunner",
      ]),
    );
  });

  it("rejects local-agent runtime modes even if environment input asks for them", () => {
    expect(() =>
      parseMatrixDesktopConfig({
        MATRIX_DESKTOP_SHELL_URL: "http://localhost:3000",
        MATRIX_DESKTOP_GATEWAY_URL: "http://localhost:4000",
        MATRIX_DESKTOP_AGENT_MODE: "local",
      }),
    ).toThrow(/cloud-only/i);
  });

  it("rejects unsafe shell and gateway protocols without exposing raw input", () => {
    expect(() =>
      parseMatrixDesktopConfig({
        MATRIX_DESKTOP_SHELL_URL: "file:///Users/alice/shell.html",
        MATRIX_DESKTOP_GATEWAY_URL: "http://localhost:4000",
      }),
    ).toThrow("Invalid Matrix desktop configuration");

    expect(() =>
      parseMatrixDesktopConfig({
        MATRIX_DESKTOP_SHELL_URL: "http://localhost:3000",
        MATRIX_DESKTOP_GATEWAY_URL: "javascript:alert(1)",
      }),
    ).toThrow("Invalid Matrix desktop configuration");
  });
});

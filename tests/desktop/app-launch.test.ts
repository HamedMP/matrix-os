import { describe, expect, it } from "vitest";
import {
  createDesktopLaunchPlan,
  parseMatrixDesktopConfig,
} from "../../apps/desktop/src/main/config.js";

describe("desktop app launch planning", () => {
  it("loads the configured Matrix shell URL and keeps reconnect metadata separate", () => {
    const config = parseMatrixDesktopConfig({
      MATRIX_DESKTOP_SHELL_URL: "https://matrix.example.com/shell",
      MATRIX_DESKTOP_GATEWAY_URL: "https://matrix.example.com",
    });

    const plan = createDesktopLaunchPlan(config, {
      lastLoadedUrl: "https://matrix.example.com/shell",
      lastFailureAt: "2026-05-14T19:00:00.000Z",
    });

    expect(plan.loadUrl).toBe("https://matrix.example.com/shell");
    expect(plan.reconnect).toEqual({
      enabled: true,
      lastLoadedUrl: "https://matrix.example.com/shell",
      lastFailureAt: "2026-05-14T19:00:00.000Z",
    });
    expect(plan.allowedOrigins).toEqual(["https://matrix.example.com"]);
  });

  it("allows local dev shell and gateway origins during development", () => {
    const config = parseMatrixDesktopConfig({
      MATRIX_DESKTOP_SHELL_URL: "http://localhost:3000",
      MATRIX_DESKTOP_GATEWAY_URL: "http://localhost:4000",
    });

    expect(createDesktopLaunchPlan(config).allowedOrigins).toEqual([
      "http://localhost:3000",
      "http://localhost:4000",
    ]);
  });
});

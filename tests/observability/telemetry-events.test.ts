import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { MATRIX_TELEMETRY_EVENTS, isMatrixTelemetryEvent } from "../../packages/observability/src/events.js";

describe("Matrix telemetry events", () => {
  it("names product lifecycle, runtime, shell, websocket, CLI, app, and billing events explicitly", () => {
    expect(MATRIX_TELEMETRY_EVENTS).toMatchObject({
      USER_SIGNED_UP: "matrix_user_signed_up",
      BILLING_EVENT_RECEIVED: "matrix_billing_event_received",
      RUNTIME_UPGRADE_REQUESTED: "matrix_runtime_upgrade_requested",
      RUNTIME_UPGRADE_STARTED: "matrix_runtime_upgrade_started",
      RUNTIME_UPGRADE_COMPLETED: "matrix_runtime_upgrade_completed",
      RUNTIME_UPGRADE_FAILED: "matrix_runtime_upgrade_failed",
      SHELL_LOADED: "matrix_shell_loaded",
      SHELL_APP_OPENED: "matrix_shell_app_opened",
      SHELL_WS_RECONNECT_EXHAUSTED: "matrix_shell_ws_reconnect_exhausted",
      PLATFORM_WS_AUTH_FAILED: "matrix_ws_platform_auth_failed",
      CLI_INSTALLED: "matrix_cli_installed",
      CLI_LOGGED_IN: "matrix_cli_logged_in",
      CLI_COMMAND_RUN: "matrix_cli_command_run",
    });
  });

  it("keeps event names low-cardinality and secret-free", () => {
    const names = Object.values(MATRIX_TELEMETRY_EVENTS);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^[a-z][a-z0-9_]{2,96}$/);
      expect(name).not.toMatch(/token|secret|cookie|jwt|bearer/i);
      expect(isMatrixTelemetryEvent(name)).toBe(true);
    }
    expect(isMatrixTelemetryEvent("matrix_unknown_event")).toBe(false);
  });

  it("keeps browser telemetry imports on the event-only subpath", async () => {
    const browserFiles = [
      "shell/src/app/page.tsx",
      "shell/src/components/AppViewer.tsx",
      "shell/src/hooks/useSocket.ts",
    ];

    for (const file of browserFiles) {
      const source = await readFile(file, "utf8");
      expect(source, file).toContain("@matrix-os/observability/events");
      expect(source, file).not.toContain(`from "@matrix-os/observability"`);
      expect(source, file).not.toContain(`from '@matrix-os/observability'`);
    }
  });
});

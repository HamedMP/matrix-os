import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { MATRIX_TELEMETRY_EVENTS, isMatrixTelemetryEvent } from "../../packages/observability/src/events.js";

describe("Matrix telemetry events", () => {
  it("names product lifecycle, runtime, shell, websocket, CLI, app, and billing events explicitly", () => {
    expect(MATRIX_TELEMETRY_EVENTS).toMatchObject({
      MARKETING_LANDING_VIEWED: "matrix_marketing_landing_viewed",
      MARKETING_SIGNUP_CLICKED: "matrix_marketing_signup_clicked",
      MARKETING_BILLING_VIEWED: "matrix_marketing_billing_viewed",
      MARKETING_BILLING_PLAN_CLICKED: "matrix_marketing_billing_plan_clicked",
      USER_SIGNED_UP: "matrix_user_signed_up",
      BILLING_CHECKOUT_STARTED: "matrix_billing_checkout_started",
      BILLING_CHECKOUT_CREATED: "matrix_billing_checkout_created",
      BILLING_CHECKOUT_FAILED: "matrix_billing_checkout_failed",
      BILLING_CHECKOUT_COMPLETED: "matrix_billing_checkout_completed",
      BILLING_CHECKOUT_EXPIRED: "matrix_billing_checkout_expired",
      BILLING_SUBSCRIPTION_UPDATED: "matrix_billing_subscription_updated",
      BILLING_EVENT_RECEIVED: "matrix_billing_event_received",
      VPS_PROVISION_REQUESTED: "matrix_vps_provision_requested",
      VPS_PROVISION_FAILED: "matrix_vps_provision_failed",
      VPS_REGISTERED: "matrix_vps_registered",
      VPS_REGISTRATION_FAILED: "matrix_vps_registration_failed",
      RUNTIME_ACTIVATED: "matrix_runtime_activated",
      RUNTIME_MANAGER_VIEWED: "matrix_runtime_manager_viewed",
      ADD_COMPUTER_INTENT: "matrix_add_computer_intent",
      ADD_COMPUTER_BILLING_HANDOFF: "matrix_add_computer_billing_handoff",
      ADD_COMPUTER_PROVISIONING_STARTED: "matrix_add_computer_provisioning_started",
      ADD_COMPUTER_COMPLETED: "matrix_add_computer_completed",
      ADD_COMPUTER_FAILED: "matrix_add_computer_failed",
      BILLING_WEBHOOK_FAILED: "matrix_billing_webhook_failed",
      ONBOARDING_FAILED: "matrix_onboarding_failed",
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
      "shell/src/components/ShellHome.tsx",
      "shell/src/components/AppViewer.tsx",
      "shell/src/hooks/useSocket.ts",
      "shell/src/components/runtime/RuntimeManager.tsx",
    ];

    for (const file of browserFiles) {
      const source = await readFile(file, "utf8");
      expect(source, file).toContain("@matrix-os/observability/events");
      expect(source, file).not.toContain(`from "@matrix-os/observability"`);
      expect(source, file).not.toContain(`from '@matrix-os/observability'`);
    }
  });
});

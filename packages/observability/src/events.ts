export const MATRIX_TELEMETRY_EVENTS = {
  USER_SIGNED_UP: "matrix_user_signed_up",
  BILLING_EVENT_RECEIVED: "matrix_billing_event_received",
  VPS_PROVISION_REQUESTED: "matrix_vps_provision_requested",
  VPS_PROVISION_FAILED: "matrix_vps_provision_failed",
  VPS_REGISTERED: "matrix_vps_registered",
  VPS_REGISTRATION_FAILED: "matrix_vps_registration_failed",
  BILLING_WEBHOOK_FAILED: "matrix_billing_webhook_failed",
  ONBOARDING_FAILED: "matrix_onboarding_failed",
  HOST_BUNDLE_RELEASE_REGISTERED: "host_bundle_release_registered",
  HOST_BUNDLE_CHANNEL_PROMOTED: "host_bundle_channel_promoted",
  RUNTIME_UPGRADE_REQUESTED: "matrix_runtime_upgrade_requested",
  RUNTIME_UPGRADE_STARTED: "matrix_runtime_upgrade_started",
  RUNTIME_UPGRADE_COMPLETED: "matrix_runtime_upgrade_completed",
  RUNTIME_UPGRADE_FAILED: "matrix_runtime_upgrade_failed",
  SHELL_LOADED: "matrix_shell_loaded",
  SHELL_APP_OPENED: "matrix_shell_app_opened",
  SHELL_WS_CONNECTED: "matrix_shell_ws_connected",
  SHELL_WS_RECONNECT_STARTED: "matrix_shell_ws_reconnect_started",
  SHELL_WS_RECONNECT_EXHAUSTED: "matrix_shell_ws_reconnect_exhausted",
  PLATFORM_WS_AUTH_FAILED: "matrix_ws_platform_auth_failed",
  PLATFORM_WS_UNAUTHENTICATED: "matrix_ws_platform_unauthenticated",
  PLATFORM_WS_ENTITLEMENT_DENIED: "matrix_ws_platform_entitlement_denied",
  PLATFORM_WS_UPSTREAM_FAILED: "matrix_ws_platform_upstream_failed",
  CLI_INSTALLED: "matrix_cli_installed",
  CLI_LOGGED_IN: "matrix_cli_logged_in",
  CLI_COMMAND_RUN: "matrix_cli_command_run",
} as const;

export type MatrixTelemetryEvent = typeof MATRIX_TELEMETRY_EVENTS[keyof typeof MATRIX_TELEMETRY_EVENTS];

export function isMatrixTelemetryEvent(value: string): value is MatrixTelemetryEvent {
  return (Object.values(MATRIX_TELEMETRY_EVENTS) as string[]).includes(value);
}

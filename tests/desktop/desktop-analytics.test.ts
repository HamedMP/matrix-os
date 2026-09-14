// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_ANALYTICS_EVENT,
  DesktopAnalyticsDetailSchema,
  trackDesktopEvent,
} from "@desktop/renderer/src/lib/desktop-analytics";

describe("Desktop analytics allowlist", () => {
  it.each([
    "desktop_application_opened",
    "desktop_application_quit_requested",
    "desktop_auth_completed",
    "desktop_sign_out",
    "desktop_identity_reset",
    "desktop_support_opened",
    "desktop_support_closed",
    "desktop_support_send_attempted",
    "desktop_support_send_succeeded",
    "desktop_app_creation_started",
  ])("accepts the property-free critical event %s", (name) => {
    expect(DesktopAnalyticsDetailSchema.safeParse({ name }).success).toBe(true);
  });

  it("accepts only privacy-safe app kinds for Desktop lifecycle events", () => {
    expect(DesktopAnalyticsDetailSchema.safeParse({
      name: "desktop_app_opened",
      appKind: "chat",
    }).success).toBe(true);
    expect(DesktopAnalyticsDetailSchema.safeParse({
      name: "desktop_app_opened",
      appKind: "installed_app",
    }).success).toBe(true);
    expect(DesktopAnalyticsDetailSchema.safeParse({
      name: "desktop_app_opened",
      appKind: "customer-roadmap",
    }).success).toBe(false);
  });

  it("accepts privacy-safe Chat routing metadata and response length", () => {
    expect(DesktopAnalyticsDetailSchema.safeParse({
      name: "desktop_chat_message_send_attempted",
      chatScope: "project",
      hasAttachments: true,
    }).success).toBe(true);
    expect(DesktopAnalyticsDetailSchema.safeParse({
      name: "desktop_chat_message_send_succeeded",
      chatScope: "global",
      hasAttachments: false,
      harness: "codex",
      modelProvider: "openai",
      model: "gpt-5.6-sol",
    }).success).toBe(true);
    expect(DesktopAnalyticsDetailSchema.safeParse({
      name: "desktop_chat_message_send_failed",
      chatScope: "global",
      hasAttachments: false,
      failureKind: "network",
    }).success).toBe(true);
    expect(DesktopAnalyticsDetailSchema.safeParse({
      name: "desktop_chat_response_completed",
      chatScope: "project",
      harness: "hermes",
      modelProvider: "anthropic",
      model: "anthropic:claude-opus-5",
      responseCharacterCount: 420,
    }).success).toBe(true);
    expect(DesktopAnalyticsDetailSchema.safeParse({
      name: "desktop_chat_message_send_failed",
      chatScope: "global",
      hasAttachments: false,
      failureKind: "server",
      message: "private prompt",
      chatId: "chat_private",
      model: "private-model",
    }).success).toBe(false);
    expect(DesktopAnalyticsDetailSchema.safeParse({
      name: "desktop_chat_response_completed",
      chatScope: "global",
      harness: "hermes",
      modelProvider: "anthropic",
      model: "anthropic:claude-opus-5",
      responseCharacterCount: 5,
      response: "private response",
    }).success).toBe(false);
  });

  it("accepts only a coarse failure kind on Support send failure", () => {
    expect(DesktopAnalyticsDetailSchema.safeParse({
      name: "desktop_support_send_failed",
      failureKind: "network",
    }).success).toBe(true);
    expect(DesktopAnalyticsDetailSchema.safeParse({
      name: "desktop_support_send_failed",
      failureKind: "server",
      error: "token at /home/matrix/private",
    }).success).toBe(false);
  });

  it.each(["message", "prompt", "command", "output", "name", "path", "url", "token", "error"])(
    "rejects the forbidden %s property",
    (property) => {
      expect(DesktopAnalyticsDetailSchema.safeParse({
        name: "desktop_support_send_attempted",
        [property]: "private value",
      }).success).toBe(false);
    },
  );

  it("does not dispatch malformed or unknown telemetry", () => {
    const listener = vi.fn();
    window.addEventListener(DESKTOP_ANALYTICS_EVENT, listener);

    expect(trackDesktopEvent({
      name: "desktop_support_send_attempted",
      prompt: "private prompt",
    } as never)).toBe(false);
    expect(trackDesktopEvent({ name: "desktop_everything_clicked" } as never)).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    window.removeEventListener(DESKTOP_ANALYTICS_EVENT, listener);
  });
});

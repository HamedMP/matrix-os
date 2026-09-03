import { z } from "zod/v4";

const PropertyFreeDesktopEventSchema = z.object({
  name: z.enum([
    "desktop_application_opened",
    "desktop_application_quit_requested",
    "desktop_auth_completed",
    "desktop_sign_out",
    "desktop_identity_reset",
    "desktop_support_identity_unavailable",
    "desktop_support_opened",
    "desktop_support_closed",
    "desktop_support_send_attempted",
    "desktop_support_send_succeeded",
    "desktop_app_creation_started",
    "desktop_shown",
    "desktop_icon_moved",
    "desktop_icon_removed",
  ]),
}).strict();

export const DesktopAppKindSchema = z.enum([
  "chat",
  "terminal",
  "files",
  "editor",
  "vscode",
  "settings",
  "plugins",
  "browser",
  "notes",
  "whiteboard",
  "installed_app",
  "coding_agent",
]);

const AppLifecycleDesktopEventSchema = z.object({
  name: z.enum([
    "desktop_app_opened",
    "desktop_app_focused",
    "desktop_app_minimized",
    "desktop_app_closed",
  ]),
  appKind: DesktopAppKindSchema.optional(),
}).strict();

const LauncherDesktopEventSchema = z.object({
  name: z.literal("desktop_launcher_toggled"),
  open: z.boolean(),
}).strict();

const SupportSendFailureEventSchema = z.object({
  name: z.literal("desktop_support_send_failed"),
  failureKind: z.enum(["client", "server", "network", "unknown"]),
}).strict();

const ChatSendEventSchema = z.object({
  name: z.enum([
    "desktop_chat_message_send_attempted",
    "desktop_chat_message_send_succeeded",
  ]),
  chatScope: z.enum(["global", "project"]),
  hasAttachments: z.boolean(),
}).strict();

const ChatSendFailureEventSchema = z.object({
  name: z.literal("desktop_chat_message_send_failed"),
  chatScope: z.enum(["global", "project"]),
  hasAttachments: z.boolean(),
  failureKind: z.enum(["client", "server", "network", "unknown"]),
}).strict();

export const DesktopAnalyticsDetailSchema = z.union([
  PropertyFreeDesktopEventSchema,
  AppLifecycleDesktopEventSchema,
  LauncherDesktopEventSchema,
  SupportSendFailureEventSchema,
  ChatSendEventSchema,
  ChatSendFailureEventSchema,
]);

export type DesktopAnalyticsDetail = z.infer<typeof DesktopAnalyticsDetailSchema>;
export type DesktopAppKind = z.infer<typeof DesktopAppKindSchema>;

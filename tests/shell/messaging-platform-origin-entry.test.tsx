// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ api: { get: vi.fn() }, userId: "synthetic-owner", authGeneration: 2,
  platformHost: "https://messaging-stage.example.com" as string | undefined, runtimeSlot: "review" }));
const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../desktop/src/renderer/src/stores/connection", () => ({ useConnection: (select: (value: typeof state) => unknown) => select(state) }));
vi.mock("../../desktop/src/renderer/src/lib/operator", () => ({ invoke }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "synthetic-owner", sessionId: "synthetic-session", getToken: async () => "synthetic-token" }) }));
vi.mock("@/lib/self-host-mode", () => ({ isSelfHostedRuntime: () => false }));
vi.mock("@matrix-os/ui", async () => ({
  ...await import("../../packages/ui/src/messaging/SlackInstallPanel"),
  ...await import("../../packages/ui/src/messaging/WhatsAppSettingsPanel"),
}));
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); state.platformHost = "https://messaging-stage.example.com"; });

it("keeps Electron platform links disabled until main-owned authority is available", async () => {
  state.platformHost = undefined;
  state.api.get.mockResolvedValue({ connected: false, admission: "public" });
  const { default: MessagingSection } = await import("../../desktop/src/renderer/src/features/settings/sections/MessagingSection");
  const view = render(<MessagingSection />);
  expect(screen.queryByRole("link", { name: "Add to Slack" })).toBeNull();
  expect(screen.getByRole("button", { name: "Add to Slack" }).hasAttribute("disabled")).toBe(true);
  state.platformHost = "https://messaging-stage.example.com";
  view.rerender(<MessagingSection />);
  await screen.findByText("Not connected");
  expect(screen.getByRole("link", { name: "Add to Slack" }).getAttribute("href")).toBe("https://messaging-stage.example.com/slack/install");
  expect(screen.getByRole("link", { name: "Connect WhatsApp" }).getAttribute("href")).toBe("https://messaging-stage.example.com/whatsapp/connect");
});

it("injects the Web build origin into real shared Settings links and preserves same-origin authenticated reads", async () => {
  vi.stubEnv("NEXT_PUBLIC_MATRIX_APP_URL", "https://messaging-stage.example.com");
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ connected: false, admission: "public" }) });
  vi.stubGlobal("fetch", fetcher);
  const { MessagingSection } = await import("../../shell/src/components/settings/sections/MessagingSection");
  render(<MessagingSection />);
  await screen.findByText("Not connected");
  expect(screen.getByRole("link", { name: "Add to Slack" }).getAttribute("href")).toBe("https://messaging-stage.example.com/slack/install");
  expect(screen.getByRole("link", { name: "Connect WhatsApp" }).getAttribute("href")).toBe("https://messaging-stage.example.com/whatsapp/connect");
  expect(fetcher).toHaveBeenCalledWith("/api/whatsapp/settings", expect.objectContaining({ headers: { authorization: "Bearer synthetic-token" } }));
});

it("injects Electron's main-owned auth authority independently of selected computer or API link data", async () => {
  state.api.get.mockResolvedValue({ connected: true, maskedSender: "your WhatsApp account", admission: "public", chatId: "chat_stage" });
  const { default: MessagingSection } = await import("../../desktop/src/renderer/src/features/settings/sections/MessagingSection");
  render(<MessagingSection />);
  await screen.findByText("Connected");
  const slack = screen.getByRole("link", { name: "Add to Slack" });
  expect(slack.getAttribute("href")).toBe("https://messaging-stage.example.com/slack/install");
  fireEvent.click(slack);
  expect(invoke).toHaveBeenCalledWith("shell:open-external", { url: slack.getAttribute("href") });
  const chat = screen.getByRole("link", { name: "Open Matrix Chat" });
  expect(chat.getAttribute("href")).toBe("https://messaging-stage.example.com/open?chat=chat_stage");
  fireEvent.click(chat);
  expect(invoke).toHaveBeenCalledWith("shell:open-external", { url: chat.getAttribute("href") });
  expect(state.api.get).toHaveBeenCalledWith("/api/whatsapp/settings", { maxBytes: 4096 });
});

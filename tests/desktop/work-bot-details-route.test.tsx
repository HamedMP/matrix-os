// @vitest-environment jsdom
import React, { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkSurfaceRuntimeProvider, useWorkSurfaceRuntime } from "@desktop/renderer/src/features/work/WorkSurfaceRuntime";
import { WorkRail } from "@desktop/renderer/src/features/work/WorkRail";
import { CanonicalChatClientProvider } from "@desktop/renderer/src/features/chat/CanonicalChatClientContext";
import { CanonicalChatRoute } from "@desktop/renderer/src/features/chat/CanonicalChatRoute";
import { BotDetailsContext } from "@desktop/renderer/src/features/desktop-shell/SurfaceChrome";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { saved } from "./chat-agents-fixture";

const fixture = createCanonicalChatFixture("completed");
const { project, providerBinding, activeRun, ...chat } = fixture.snapshot.chat;
const record = { chat, projectId: project?.projectId, providerBinding, activeRun };
const bot = { ...saved, recipeRef: { recipeId: "writer", version: "1" }, selection: { instanceId: "matrix_bot_default", model: "auto" } };
function routeApi(): ApiClient {
  return {
    baseUrl: "https://runtime.test",
    forRuntime() { return this; },
    get: vi.fn(async (path: string) => {
      if (path.startsWith("/api/chat-providers")) return fixture.providerCatalog;
      if (path === "/api/chat-agents") return { enabled: true, agents: [bot] };
      if (path === `/api/chat-agents/${bot.id}/direct-chat`) return { chatId: record.chat.id };
      if (path === `/api/chat-agents/${bot.id}/authority`) return { agentId: bot.id, revision: 1, grants: [], connections: [], routines: [], pendingInteractions: [], memory: { items: [] } };
      if (path === `/api/chats/${record.chat.id}/bot`) return { agentId: bot.id };
      if (path === `/api/chats/${record.chat.id}/interactions`) return { interactions: [] };
      if (path === `/api/chats/${record.chat.id}/bot-tasks`) return { tasks: [] };
      if (path.startsWith(`/api/chats/${record.chat.id}?`)) return { record, messages: fixture.snapshot.messages, turns: fixture.snapshot.turns, runs: fixture.snapshot.runs, activities: fixture.snapshot.activities };
      if (path.startsWith("/api/chats?")) return { items: [record] };
      throw new Error("Unexpected test route");
    }),
    post: vi.fn(async (path: string) => {
      if (path === `/api/chat-agents/${bot.id}/direct-chat`) return { chatId: record.chat.id };
      throw new Error("Unexpected test mutation");
    }),
    patch: vi.fn(), delete: vi.fn(),
  } as unknown as ApiClient;
}
function Surface({ api, staleScope }: { api: ApiClient; staleScope?: "transport" | "runtime" | "auth" }) {
  const runtime = useWorkSurfaceRuntime()!;
  const [chatId, setChatId] = useState<string>();
  const [details, setDetails] = useState<HTMLElement | null>(null);
  const route = <CanonicalChatRoute api={api} projectId={null} active externalNavigation initialChatId={chatId} initialView={chatId ? "conversation" : "draft"} fallback={<p>Fallback</p>} />;
  return <BotDetailsContext.Provider value={details}>
    <section ref={setDetails} data-testid="native-details-host" />
    <WorkRail client={runtime.client} projects={[]} active activeChatId={chatId} onOpenBotChat={setChatId}
      onNewGlobalChat={vi.fn()} onCreateProject={vi.fn()} onNewProjectChat={vi.fn()} onSelectChat={vi.fn()} onCollapse={vi.fn()} />
    {staleScope ? <CanonicalChatClientProvider client={runtime.client} api={staleScope === "transport" ? routeApi() : api}
      runtimeSlot={staleScope === "runtime" ? "another-runtime" : "primary"} authGeneration={staleScope === "auth" ? 0 : 1}>
      {route}
    </CanonicalChatClientProvider> : route}
  </BotDetailsContext.Provider>;
}
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  useConnection.setState({ ...useConnection.getInitialState(), status: "signed-in", organizationStatus: "none", runtimeSlot: "primary", authGeneration: 1 }, true);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); useConnection.setState(useConnection.getInitialState(), true); });
it("opens Agent Details through distinct real frame rail and canonical route composition, including the current Bot", async () => {
  const api = routeApi();
  useConnection.setState({ api });
  render(<WorkSurfaceRuntimeProvider active={false}><Surface api={api} /></WorkSurfaceRuntimeProvider>);
  const trigger = await screen.findByRole("button", { name: `Actions for ${bot.name}` });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Details" }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith(`/api/chat-agents/${bot.id}/direct-chat`, {}));
  await waitFor(() => expect(api.get).toHaveBeenCalledWith(`/api/chats/${record.chat.id}/bot`));
  expect(screen.queryByText("Fallback")).toBeNull();
  expect(await screen.findByRole("region", { name: "Bot controls" })).toBeTruthy();
  const panel = await screen.findByRole("complementary", { name: "Bot details" });
  expect(panel.parentElement).toBe(screen.getByTestId("native-details-host"));
  fireEvent.click(screen.getByRole("button", { name: "Close bot details" }));
  expect(screen.queryByRole("complementary", { name: "Bot details" })).toBeNull();
  fireEvent.pointerDown(screen.getByRole("button", { name: `Actions for ${bot.name}` }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Details" }));
  expect(await screen.findByRole("complementary", { name: "Bot details" })).toBeTruthy();
});

it.each(["transport", "runtime", "auth"] as const)("rejects a stale %s client scope even at the same Gateway URL", async (staleScope) => {
  const api = routeApi();
  useConnection.setState({ api });
  render(<WorkSurfaceRuntimeProvider active={false}><Surface api={api} staleScope={staleScope} /></WorkSurfaceRuntimeProvider>);
  fireEvent.pointerDown(await screen.findByRole("button", { name: `Actions for ${bot.name}` }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Details" }));
  expect(await screen.findByRole("region", { name: "Bot controls" })).toBeTruthy();
  const ownDetails = screen.getByRole("button", { name: "Details", exact: true });
  expect(ownDetails.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("complementary", { name: "Bot details" })).toBeNull();
  // The current route works: only the foreign rail request is fenced out.
  fireEvent.click(ownDetails);
  expect(await screen.findByRole("complementary", { name: "Bot details" })).toBeTruthy();
});

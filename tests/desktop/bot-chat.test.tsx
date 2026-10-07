// @vitest-environment jsdom
import React from "react";
import { setSharedComposerText } from "./shared-chat-composer-test-utils";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { createCanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import { ChatAgentsWorkspace, useChatAgentsNavigation, type ChatAgentClient } from "@matrix-os/ui";
import type { CanonicalChatEventSource, CanonicalChatInvalidation } from "@matrix-os/ui";
import { createCanonicalChatWorkspaceClient, canonicalChatRecord, providerCatalog, snapshot } from "./canonical-chat-workspace-test-utils";
import { BotDetailsContext, BotHeaderContext } from "@desktop/renderer/src/features/desktop-shell/SurfaceChrome";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { stopDesktopProviderCatalogCoordinator } from "@desktop/renderer/src/features/chat/provider-catalog-coordinator";
import { resetProviderPreferences } from "./provider-preferences-test-utils";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  globalThis.ResizeObserver = class implements ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
beforeEach(() => {
  stopDesktopProviderCatalogCoordinator();
  resetProviderPreferences({ hydrated: true });
  useConnection.setState(useConnection.getInitialState(), true);
  useConnection.setState({ status: "signed-in", handle: "operator", platformHost: "https://platform.test",
    runtimeSlot: "primary", authGeneration: 1, api: null });
});
afterEach(() => {
  cleanup();
  stopDesktopProviderCatalogCoordinator();
  useConnection.setState(useConnection.getInitialState(), true);
  vi.restoreAllMocks();
});

describe("Electron Desktop bot Chat", () => {
  it("preserves visible Bot details and unsaved edits across focus changes, then cleans up when hidden", async () => {
    const client = createCanonicalChatWorkspaceClient();
    client.agents = {
      bots: {
        directBot: vi.fn(async () => "bot_research1"),
        interactions: vi.fn(async () => [{
          interactionId: "in_abcdefgh", chatId: snapshot.chat.id, agentId: "bot_research1",
          taskId: "task_abcdefgh", kind: "question", blocking: true, status: "pending",
          expiresAt: "2099-01-01T00:00:00.000Z", revision: 1,
          payload: { kind: "question", questions: [{ questionId: "target", header: "Target", question: "Which company?" }] },
        }]),
        tasks: vi.fn(async () => []),
        authority: vi.fn(async () => ({ agentId: "bot_research1", revision: 1, grants: [], connections: [], routines: [],
          pendingInteractions: [], memory: { items: [{ itemId: "mem_abcdefgh", kind: "preference", scope: "bot",
            content: "Keep briefs concise", source: { at: "2026-09-28T12:00:00.000Z" }, confirmed: true, revision: 1 }] } })),
      },
      list: vi.fn(async () => ({ enabled: true, agents: [{ id: "bot_research1", name: "Research Rabbit", revision: 1, instructions: "Research source-backed briefs.", description: "Research", archived: false, createdAt: "2026-09-28T12:00:00.000Z", updatedAt: "2026-09-28T12:00:00.000Z", selection: { instanceId: "matrix_bot_default", model: "automatic" }, recipeRef: { recipeId: "research", version: "1" } }] })),
    } as unknown as ChatAgentClient;

    function HostedBot({ active = true, live = true }: { active?: boolean; live?: boolean }) {
      const [header, setHeader] = React.useState<HTMLElement | null>(null);
      const [details, setDetails] = React.useState<HTMLElement | null>(null);
      return <BotDetailsContext.Provider value={details}><BotHeaderContext.Provider value={header}>
        <section ref={setDetails} data-testid="bot-details-host" />
        <header ref={setHeader} data-testid="bot-toolbar" />
        <CanonicalChatWorkspace client={client} projectId="matrix-os" initialChatId={snapshot.chat.id}
          initialView="conversation" active={active} live={live} catalog={providerCatalog} />
      </BotHeaderContext.Provider></BotDetailsContext.Provider>;
    }
    const { rerender } = render(<HostedBot />);

    expect((await screen.findAllByText("Research Rabbit")).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Details" }).closest("header")).toBe(screen.getByTestId("bot-toolbar"));
    expect(document.querySelector("[data-slot='canonical-chat-workspace'] .matrix-bot-identity-bar")).toBeNull();
    expect(await screen.findByText("Which company?")).toBeTruthy();
    const host = screen.getByTestId("bot-details-host");
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue({ width: 900 } as DOMRect);
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(await screen.findByText("Keep briefs concise")).toBeTruthy();
    expect(screen.getByText("Keep briefs concise").closest("aside")?.parentElement).toBe(screen.getByTestId("bot-details-host"));
    fireEvent.click(screen.getByRole("button", { name: "Edit bot" }));
    const nameInput = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(nameInput, { target: { value: "Unsaved research name" } });
    rerender(<HostedBot active={false} live />);
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveProperty("value", "Unsaved research name");
    expect(host.querySelector("aside")).toBeTruthy();
    expect(host.style.getPropertyValue("--matrix-bot-details-reserve")).toBe("360px");

    rerender(<HostedBot active={false} live={false}/>);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit bot" })).toBeNull());
    expect(host.style.getPropertyValue("--matrix-bot-details-reserve")).toBe("");

    await waitFor(() => expect(screen.getByTestId("bot-details-host").querySelector("aside")).toBeNull());
    await waitFor(() => expect(client.agents!.bots!.directBot).toHaveBeenCalledWith(snapshot.chat.id));
  });

  it.each(["Agents", "Add new agent"])("closes frame Details and releases its reservation when opening %s", async label => {
    const client = createCanonicalChatWorkspaceClient();
    client.agents = {
      bots: { directBot: vi.fn(async () => "bot_research1") },
      list: vi.fn(async () => ({ enabled: true, agents: [{ id: "bot_research1", name: "Research Rabbit", revision: 1,
        instructions: "Research", description: "Research", archived: false, createdAt: "2026-09-28T12:00:00.000Z",
        updatedAt: "2026-09-28T12:00:00.000Z", selection: { instanceId: "matrix_bot_default", model: "automatic" } }] })),
    } as unknown as ChatAgentClient;
    function HostedBot() {
      const navigation = useChatAgentsNavigation();
      const [host, setHost] = React.useState<HTMLElement | null>(null);
      return <BotDetailsContext.Provider value={host}>
        <section data-testid="navigation-details-host" ref={setHost}/>
        <button onClick={event => navigation!.open({ client: client.agents!, view: label === "Agents" ? "library" : "recipes" }, event.currentTarget)}>{label}</button>
        <button onClick={() => navigation!.close()}>Return to Chat</button>
        <CanonicalChatWorkspace client={client} projectId="matrix-os" initialChatId={snapshot.chat.id} initialView="conversation" active catalog={providerCatalog}/>
      </BotDetailsContext.Provider>;
    }
    render(<ChatAgentsWorkspace><HostedBot/></ChatAgentsWorkspace>);
    const detailsButton = await screen.findByRole("button", { name: "Details", exact: true });
    const host = screen.getByTestId("navigation-details-host");
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue({ width: 900 } as DOMRect);
    fireEvent.click(detailsButton);
    await screen.findByRole("button", { name: "Close bot details" });
    expect(host.style.getPropertyValue("--matrix-bot-details-reserve")).toBe("360px");
    fireEvent.click(screen.getByRole("button", { name: label, exact: true }));
    await waitFor(() => expect(host.querySelector("aside")).toBeNull());
    expect(host.style.getPropertyValue("--matrix-bot-details-reserve")).toBe("");
    expect(host.hasAttribute("data-bot-details-reserved")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Return to Chat" }));
    expect(screen.getByRole("button", { name: "Details", exact: true }).getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector("aside")).toBeNull();
  });

  it("uses DELETE for grant revocation", async () => {
    const remove = vi.fn(async () => ({ grantId: "gr_abcdefgh", revokedAt: "2026-09-28T12:00:00.000Z" }));
    const patch = vi.fn();
    const client = createCanonicalChatClient({ get: vi.fn(), post: vi.fn(), patch, delete: remove } as unknown as ApiClient);
    await client.agents!.bots!.revoke("bot_research1", "gr_abcdefgh");
    expect(remove).toHaveBeenCalledWith("/api/chat-agents/bot_research1/grants/gr_abcdefgh");
    expect(patch).not.toHaveBeenCalled();
  });

  it("refreshes bot controls on bot events without a chat revision change", async () => {
    const client = createCanonicalChatWorkspaceClient();
    const interactions = vi.fn(async () => []);
    client.agents = { bots: {
      directBot: vi.fn(async () => "bot_research1"), interactions,
      tasks: vi.fn(async () => []), authority: vi.fn(async () => ({ agentId: "bot_research1", revision: 1,
        grants: [], connections: [], routines: [], pendingInteractions: [], memory: { items: [] } })),
    }, list: vi.fn(async () => ({ enabled: true, agents: [{ id: "bot_research1", name: "Research Rabbit", revision: 1, instructions: "Research source-backed briefs.", description: "Research", archived: false, createdAt: "2026-09-28T12:00:00.000Z", updatedAt: "2026-09-28T12:00:00.000Z", selection: { instanceId: "matrix_bot_default", model: "auto" }, recipeRef: { recipeId: "research", version: "1" } }] })) } as unknown as ChatAgentClient;
    const listeners = new Set<(event: CanonicalChatInvalidation) => void>();
    const eventSource = { subscribe(listener: (event: CanonicalChatInvalidation) => void) {
      listeners.add(listener); return { dispose: () => { listeners.delete(listener); } };
    } } as CanonicalChatEventSource;
    render(<CanonicalChatWorkspace client={client} projectId="matrix-os" initialChatId={snapshot.chat.id}
      initialView="conversation" active catalog={providerCatalog} eventSource={eventSource} />);
    await waitFor(() => expect(interactions).toHaveBeenCalledTimes(1));
    act(() => { for (const listener of listeners) listener({ type: "chat.changed", chatId: snapshot.chat.id,
      cursor: 10, revision: snapshot.chat.revision, eventType: "bot.interaction.created" }); });
    await waitFor(() => expect(interactions).toHaveBeenCalledTimes(2));
  });

  it("resolves a question and revokes a grant from rendered controls", async () => {
    const client = createCanonicalChatWorkspaceClient();
    const interactions = vi.fn(async () => [{ interactionId: "in_abcdefgh", chatId: snapshot.chat.id,
      agentId: "bot_research1", taskId: "task_abcdefgh", kind: "question" as const, blocking: true,
      status: "pending" as const, expiresAt: "2099-01-01T00:00:00.000Z", revision: 1,
      payload: { kind: "question" as const, questions: [{ questionId: "target", header: "Target", question: "Which company?" }] } }]);
    const resolve = vi.fn(async () => ({ interaction: { interactionId: "in_abcdefgh", status: "resolved", revision: 2 } }));
    const revoke = vi.fn(async () => undefined);
    client.agents = { bots: { directBot: vi.fn(async () => "bot_research1"), interactions,
      tasks: vi.fn(async () => []), resolve, revoke,
      authority: vi.fn(async () => ({ agentId: "bot_research1", revision: 1,
        grants: [{ grantId: "gr_abcdefgh", service: "gmail", accountLabel: "Work", effects: ["read"], audience: "direct", expiresAt: null }],
        connections: [{ service: "gmail", state: "granted" }], routines: [], pendingInteractions: [], memory: { items: [] } })),
    }, list: vi.fn(async () => ({ enabled: true, agents: [{ id: "bot_research1", name: "Research Rabbit", revision: 1, instructions: "Research source-backed briefs.", description: "Research", archived: false, createdAt: "2026-09-28T12:00:00.000Z", updatedAt: "2026-09-28T12:00:00.000Z", selection: { instanceId: "matrix_bot_default", model: "auto" }, recipeRef: { recipeId: "research", version: "1" } }] })) } as unknown as ChatAgentClient;
    render(<CanonicalChatWorkspace client={client} projectId="matrix-os" initialChatId={snapshot.chat.id}
      initialView="conversation" active catalog={providerCatalog} />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Answer Target" }), { target: { value: "Acme" } });
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(snapshot.chat.id, "in_abcdefgh",
      { kind: "question", baseRevision: 1, structuredAnswers: { target: ["Acme"] } }));
    await waitFor(() => expect(interactions.mock.calls.length).toBeGreaterThan(1));
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke Work" }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("bot_research1", "gr_abcdefgh"));
  });
});

it("admits a direct bot turn when the ordinary provider catalog is empty", async () => {
  const client = createCanonicalChatWorkspaceClient();
  vi.mocked(client.admitTurn).mockResolvedValue({ record: canonicalChatRecord, message: snapshot.messages[0]!,
    turn: snapshot.turns[0]!, run: snapshot.runs[0]!, admission: "accepted" });
  client.agents = { bots: { directBot: vi.fn(async () => "bot_research1"), interactions: vi.fn(async () => []),
    tasks: vi.fn(async () => []), authority: vi.fn(async () => ({ agentId: "bot_research1", revision: 1,
      grants: [], connections: [], routines: [], pendingInteractions: [], memory: { items: [] } })) },
    list: vi.fn(async () => ({ enabled: true, agents: [{ id: "bot_research1", name: "Research Rabbit", revision: 1, instructions: "Research source-backed briefs.", description: "Research", archived: false, createdAt: "2026-09-28T12:00:00.000Z", updatedAt: "2026-09-28T12:00:00.000Z", selection: { instanceId: "matrix_bot_default", model: "auto" }, recipeRef: { recipeId: "research", version: "1" } }] })) } as unknown as ChatAgentClient;
  render(<CanonicalChatWorkspace client={client} initialChatId={snapshot.chat.id} initialView="conversation"
    active catalog={{ ...providerCatalog, instances: [] }} />);
  await screen.findByRole("button", { name: "Choose bot agent and model" });
  expect(screen.queryByText("Bot model")).toBeNull();
  expect(screen.queryByText("Company drive context is not available in Bot chats.")).toBeNull();
  expect(screen.queryByText("Choose Claude Code to use company drive context.")).toBeNull();
  expect(screen.queryByRole("button", { name: "Add company drive context" })).toBeNull();
  const composer = screen.getByRole("textbox", { name: "Reply to chat" });
  await setSharedComposerText(composer, "Check the pages");
  await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(client.admitTurn).toHaveBeenCalledWith(snapshot.chat.id,
    expect.objectContaining({ selection: { instanceId: "matrix_bot_default", model: "auto" }, interactionMode: "default", permissionMode: "default" }), expect.anything()));
});

it("Electron Desktop custom Bot keeps its saved executor and request-scoped consent", async () => {
  const catalog = structuredClone(providerCatalog), base = catalog.instances[0]!;
  const bot = { id: "bot_custom01", name: "Custom Helper", revision: 1, instructions: "Read only", description: "", archived: false, selection: { instanceId: "hermes_custom", model: "retained" } };
  catalog.instances = [{ ...base, id: bot.selection.instanceId, driverKind: "hermes", displayName: "Hermes", models: [{ ...base.models[0]!, id: bot.selection.model }], supports: { ...base.supports, permissionModes: ["full_access"] } }];
  const client = createCanonicalChatWorkspaceClient();
  vi.mocked(client.admitTurn).mockResolvedValue({record:{...canonicalChatRecord,chat:{...canonicalChatRecord.chat,revision:canonicalChatRecord.chat.revision+1}},message:snapshot.messages[0]!,turn:snapshot.turns[0]!,run:snapshot.runs[0]!,admission:"accepted"});
  const bots = { directBot: vi.fn(async()=>bot.id), interactions: vi.fn(), tasks: vi.fn(), authority: vi.fn() };
  client.agents = { bots, list: vi.fn(async()=>({enabled:true,agents:[bot]})) } as never;
  render(<CanonicalChatWorkspace client={client} initialChatId={snapshot.chat.id} initialView="conversation" active catalog={catalog}/>);
  await screen.findAllByText(bot.name);
  await setSharedComposerText(screen.getByRole("textbox",{name:"Reply to chat"}), "Read only");
  expect(screen.getByRole("button",{name:"Send"})).toHaveProperty("disabled",true);
  fireEvent.click(screen.getByRole("checkbox",{name:"Allow Full access on this computer for this Bot request."}));
  fireEvent.click(screen.getByRole("button",{name:"Send"}));
  await waitFor(()=>expect(client.admitTurn).toHaveBeenCalledWith(snapshot.chat.id,expect.objectContaining({selection:bot.selection,permissionMode:"full_access",parts:expect.arrayContaining([{type:"resource_reference",resource:{kind:"agent",id:bot.id,label:bot.name,revision:"1"}}])}),expect.anything()));
  await waitFor(()=>expect(screen.getByRole("checkbox",{name:"Allow Full access on this computer for this Bot request."})).toHaveProperty("checked",false));
  expect(bots.authority).not.toHaveBeenCalled();expect(bots.tasks).not.toHaveBeenCalled();
});

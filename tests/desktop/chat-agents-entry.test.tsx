// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatAgentsEntry as AgentsLauncher, ChatAgentsRailSection } from "../../packages/ui/src/chat-agents/ChatAgentsEntry.js";
import { ChatAgentsWorkspace } from "../../packages/ui/src/chat-agents/ChatAgentsNavigation.js";
import { AgentRecipesPanel } from "../../packages/ui/src/chat-agents/AgentRecipesPanel.js";
import { ChatAgentsContent } from "../../packages/ui/src/chat-agents/ChatAgentsContent.js";
import type { ChatAgentClient } from "../../packages/ui/src/chat-agents/client.js";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";
import { saved, recipeCatalog, clientFixture } from "./chat-agents-fixture";

function ChatAgentsEntry({ client, scopeKey = "chat_one" }: { client: ChatAgentClient; scopeKey?: string }) {
  return <ChatAgentsWorkspace>
    <aside><AgentsLauncher client={client} /></aside>
    <main><ChatAgentsContent client={client} scopeKey={scopeKey}>
      <textarea aria-label="Chat draft" defaultValue="Original draft" />
    </ChatAgentsContent></main>
  </ChatAgentsWorkspace>;
}
function stampJevCreate(client: ReturnType<typeof clientFixture>, expectedEmail: string) {
  client.create.mockImplementation(async (input) => ({ ...saved, name: input.name, description: input.description,
    instructions: input.instructions, selection: input.selection,
    ...(input.recipe ? { recipe: { ...input.recipe,
      jevInboxTriage: { version: 1 as const, ownerId: "test_owner", service: "gmail" as const,
        accountLabel: "My Gmail", connectionId: "conn_own", expectedEmail } } } : {}),
  }));
}
afterEach(cleanup);

describe("shared Agents entry", () => {
  it("disables Agent creation and launch when the host has no Chat handoff", async () => {
    const client = clientFixture();
    client.list.mockResolvedValue({ enabled: true, agents: [saved] });
    render(<ChatAgentsWorkspace>
      <ChatAgentsRailSection client={client} />
      <ChatAgentsContent client={client} scopeKey="chat_one"><p>Current Chat</p></ChatAgentsContent>
    </ChatAgentsWorkspace>);
    expect((await screen.findByRole("button", { name: "Create an agent" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: `Chat with ${saved.name}` }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Manage agents" }));
    expect(await screen.findByRole("button", { name: `Edit ${saved.name}` })).toBeTruthy();
  });

  it("keeps Recipes browseable but disables unavailable Chat handoffs throughout the rail flow", async () => {
    const client = clientFixture();
    render(<ChatAgentsWorkspace>
      <ChatAgentsRailSection client={client} />
      <ChatAgentsContent client={client} scopeKey="chat_one"><p>Current Chat</p></ChatAgentsContent>
    </ChatAgentsWorkspace>);
    expect((await screen.findByRole("button", { name: "Build a research scout" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Build a daily planner" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Build a meeting follow-up agent" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Browse agent recipes" }));
    const useRecipe = await screen.findByRole("button", { name: "Use Account Research Desk" }) as HTMLButtonElement;
    expect(useRecipe.disabled).toBe(true);
    fireEvent.click(useRecipe);
    expect(screen.getByRole("region", { name: "Agent recipes" })).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search recipes" }), { target: { value: "Account Research Desk" } });
    expect(screen.getAllByRole("button", { name: /^Use / })).toHaveLength(1);
  });

  it("disables Build in Chat when a standalone recipe panel has no handoff", () => {
    render(<AgentRecipesPanel />);
    expect(screen.getAllByRole("button", { name: /^Use / }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  });

  it("keeps saved Agent editing reachable from the new rail", async () => {
    const client = clientFixture();
    client.list.mockResolvedValue({ enabled: true, agents: [saved] });
    render(<ChatAgentsWorkspace><ChatAgentsRailSection client={client} onStartChat={vi.fn()} />
      <ChatAgentsContent client={client} scopeKey="chat_one"><p>Current Chat</p></ChatAgentsContent></ChatAgentsWorkspace>);
    fireEvent.click(await screen.findByRole("button", { name: "Manage agents" }));
    fireEvent.click(await screen.findByRole("button", { name: `Edit ${saved.name}` }));
    expect((screen.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value).toBe(saved.instructions);
  });
  it("presents Agents as a collapsible rail section with Recipes first and conversational creation", async () => {
    const client = clientFixture();
    client.list.mockResolvedValue({ enabled: true, agents: [saved] });
    const onStartChat = vi.fn();
    render(<ChatAgentsWorkspace>
      <aside><ChatAgentsRailSection client={client} onStartChat={onStartChat} /></aside>
      <main><ChatAgentsContent client={client} scopeKey="chat_one"><p>Chat canvas</p></ChatAgentsContent></main>
    </ChatAgentsWorkspace>);

    const heading = await screen.findByRole("button", { name: "Agents" });
    expect(heading.getAttribute("aria-expanded")).toBe("true");
    const items = screen.getAllByRole("button");
    expect(items.findIndex((item) => item.getAttribute("aria-label") === "Browse agent recipes"))
      .toBeLessThan(items.findIndex((item) => item.getAttribute("aria-label") === "Chat with Meeting helper"));

    fireEvent.click(screen.getByRole("button", { name: "Create an agent" }));
    expect(onStartChat).toHaveBeenCalledWith(expect.stringContaining("create an agent"));
    fireEvent.click(screen.getByRole("button", { name: "Chat with Meeting helper" }));
    expect(onStartChat).toHaveBeenCalledWith("", [{ kind: "agent", id: saved.id, label: saved.name, revision: String(saved.revision) }]);

    fireEvent.click(heading);
    expect(heading.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Browse agent recipes" })).toBeNull();
  });

  it("offers useful build prompts when the Agents section is empty", async () => {
    render(<ChatAgentsWorkspace><ChatAgentsRailSection client={clientFixture()} onStartChat={vi.fn()} /></ChatAgentsWorkspace>);
    expect(await screen.findByRole("button", { name: "Build a research scout" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Build a daily planner" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Build a meeting follow-up agent" })).toBeTruthy();
  });

  it("opens the complete persisted inspiration catalogue from Recipes without a top divider", async () => {
    const client = clientFixture();
    const onStartChat = vi.fn();
    render(<ChatAgentsWorkspace>
      <ChatAgentsRailSection client={client} onStartChat={onStartChat} />
      <ChatAgentsContent client={client} scopeKey="chat_one"><p>Chat canvas</p></ChatAgentsContent>
    </ChatAgentsWorkspace>);
    fireEvent.click(await screen.findByRole("button", { name: "Browse agent recipes" }));
    const surface = await screen.findByRole("region", { name: "Agent recipes" });
    expect(screen.getByRole("button", { name: "Browse agent recipes" }).textContent).toContain("72");
    expect(surface.querySelector("header")?.className).not.toContain("border-b");
    expect(screen.getByText("72 recipe ideas")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use Jev Inbox Triage" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use Account Research Desk" })).toBeTruthy();
    const rabbits = surface.querySelectorAll('[data-recipe-rabbit]');
    expect(rabbits.length).toBe(72);
    expect(rabbits[0]?.getAttribute("data-recipe-rabbit")).toBe("jev-inbox-triage");
    expect(rabbits[1]?.getAttribute("data-rabbit-variant")).not.toBe(rabbits[2]?.getAttribute("data-rabbit-variant"));
    expect(rabbits[1]?.getAttribute("data-rabbit-state")).toBe("idle");
    expect(rabbits[1]?.getAttribute("data-rabbit-task")).toBe("sales");
    expect(rabbits[1]?.getAttribute("data-rabbit-color")).toBe("coral");
    expect(rabbits[1]?.querySelector(".matrix-agent-rabbit__face")).toBeTruthy();
    expect(rabbits[1]?.querySelectorAll(".matrix-agent-rabbit__inner-ear").length).toBe(2);
    expect(rabbits[0]?.querySelector(".matrix-recipe-rabbit__orbit")).toBeNull();
    expect(rabbits[0]?.getAttribute("aria-hidden")).toBe("true");
    const recipeGrid = surface.querySelector(".matrix-chat-agent-recipes__grid");
    expect(recipeGrid).toBeTruthy();
    expect(recipeGrid?.className).not.toContain("md:grid-cols-2");
    fireEvent.click(screen.getByRole("button", { name: "Use Account Research Desk" }));
    expect(onStartChat).toHaveBeenCalledWith(expect.stringContaining("Account Research Desk"));
  });

  it("creates Jev for the current user's sole connected Gmail, verifies the saved bot, then opens Chat", async () => {
    const client = clientFixture();
    stampJevCreate(client, "me@example.test");
    client.integrations.mockResolvedValue([{ service: "gmail", account_label: "My Gmail", account_email: "me@example.test", status: "active" }]);
    client.recipeCatalog.mockResolvedValue({ ...recipeCatalog, skills: [...recipeCatalog.skills,
      { id: "matrix-jev-email-triage", name: "Jev email triage", description: "Classify mail." }] });
    client.list.mockResolvedValueOnce({ enabled: true, agents: [] }).mockImplementation(async () => ({
      enabled: true, agents: client.create.mock.calls.length ? [{ ...saved, name: "Jev Inbox Triage",
        recipe: { ...client.create.mock.calls[0]![0].recipe,
          jevInboxTriage: { version: 1, ownerId: "test_owner", service: "gmail", accountLabel: "My Gmail",
            connectionId: "conn_own", expectedEmail: "me@example.test" } } }] : [],
    }));
    const onStartChat = vi.fn();
    render(<ChatAgentsWorkspace><ChatAgentsRailSection client={client} onStartChat={onStartChat} />
      <ChatAgentsContent client={client} scopeKey="chat_one"><p>Chat canvas</p></ChatAgentsContent></ChatAgentsWorkspace>);
    fireEvent.click(await screen.findByRole("button", { name: "Browse agent recipes" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search recipes" }), { target: { value: "Jev" } });
    const useJev = screen.getByRole("button", { name: "Use Jev Inbox Triage" });
    expect(useJev.textContent).toBe("Build in Chat");
    await waitFor(() => expect((useJev as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(useJev);
    await waitFor(() => expect(client.create).toHaveBeenCalledTimes(1));
    expect(client.create.mock.calls[0]![0]).toMatchObject({
      name: "Jev Inbox Triage", selection: { instanceId: "hermes_default" },
      recipe: { skills: ["matrix-jev-email-triage", "matrix-integrations"],
        integrations: [{ service: "gmail", accountLabel: "My Gmail" }] },
    });
    expect(client.create.mock.calls[0]![0].instructions).toContain('"me@example.test"');
    await waitFor(() => expect(onStartChat).toHaveBeenCalledWith("", [
      { kind: "agent", id: saved.id, label: "Jev Inbox Triage", revision: "1" },
    ]));
  });

  it("discloses beside the Jev recipe that inbox preview awaits its broker", async () => {
    const client = clientFixture();
    client.integrations.mockResolvedValue([{ service: "gmail", account_label: "My Gmail",
      account_email: "me@example.test", status: "active" }]);
    client.recipeCatalog.mockResolvedValue({ ...recipeCatalog, skills: [...recipeCatalog.skills,
      { id: "matrix-jev-email-triage", name: "Jev email triage", description: "Classify mail." }] });
    render(<ChatAgentsWorkspace><ChatAgentsRailSection client={client} onStartChat={vi.fn()} />
      <ChatAgentsContent client={client} scopeKey="chat_one"><p>Chat canvas</p></ChatAgentsContent></ChatAgentsWorkspace>);
    fireEvent.click(await screen.findByRole("button", { name: "Browse agent recipes" }));
    expect(await screen.findByText(/inbox preview is not available yet/i)).toBeTruthy();
  });

  it("accepts server-stamped readback when the account email changes after the panel loaded", async () => {
    const client = clientFixture();
    stampJevCreate(client, "new@example.test");
    client.integrations.mockResolvedValue([{ service: "gmail", account_label: "My Gmail",
      account_email: "old@example.test", status: "active" }]);
    client.recipeCatalog.mockResolvedValue({ ...recipeCatalog, skills: [...recipeCatalog.skills,
      { id: "matrix-jev-email-triage", name: "Jev email triage", description: "Classify mail." }] });
    client.list.mockResolvedValueOnce({ enabled: true, agents: [] }).mockImplementation(async () => ({
      enabled: true, agents: client.create.mock.calls.length ? [{ ...saved, name: "Jev Inbox Triage",
        recipe: { ...client.create.mock.calls[0]![0].recipe,
          jevInboxTriage: { version: 1, ownerId: "test_owner", service: "gmail", accountLabel: "My Gmail",
            connectionId: "conn_own", expectedEmail: "new@example.test" } } }] : [],
    }));
    const onStartChat = vi.fn();
    render(<ChatAgentsWorkspace><ChatAgentsRailSection client={client} onStartChat={onStartChat} />
      <ChatAgentsContent client={client} scopeKey="chat_one"><p>Chat canvas</p></ChatAgentsContent></ChatAgentsWorkspace>);
    fireEvent.click(await screen.findByRole("button", { name: "Browse agent recipes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use Jev Inbox Triage" }));
    await waitFor(() => expect(onStartChat).toHaveBeenCalledWith("", [
      { kind: "agent", id: saved.id, label: "Jev Inbox Triage", revision: "1" },
    ]));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["ownerId", "connectionId"] as const)(
    "does not open Chat when the saved and readback bindings disagree on %s", async (field) => {
      const client = clientFixture();
      stampJevCreate(client, "me@example.test");
      client.integrations.mockResolvedValue([{ service: "gmail", account_label: "My Gmail",
        account_email: "me@example.test", status: "active" }]);
      client.recipeCatalog.mockResolvedValue({ ...recipeCatalog, skills: [...recipeCatalog.skills,
        { id: "matrix-jev-email-triage", name: "Jev email triage", description: "Classify mail." }] });
      client.list.mockResolvedValueOnce({ enabled: true, agents: [] }).mockImplementation(async () => ({
        enabled: true, agents: client.create.mock.calls.length ? [{ ...saved, name: "Jev Inbox Triage",
          recipe: { ...client.create.mock.calls[0]![0].recipe,
            jevInboxTriage: { version: 1, ownerId: field === "ownerId" ? "another_owner" : "test_owner",
              service: "gmail", accountLabel: "My Gmail",
              connectionId: field === "connectionId" ? "conn_other" : "conn_own",
              expectedEmail: "me@example.test" } } }] : [],
      }));
      const onStartChat = vi.fn();
      render(<ChatAgentsWorkspace><ChatAgentsRailSection client={client} onStartChat={onStartChat} />
        <ChatAgentsContent client={client} scopeKey="chat_one"><p>Chat canvas</p></ChatAgentsContent></ChatAgentsWorkspace>);
      fireEvent.click(await screen.findByRole("button", { name: "Browse agent recipes" }));
      fireEvent.click(await screen.findByRole("button", { name: "Use Jev Inbox Triage" }));
      expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("could not be verified"));
      expect(onStartChat).not.toHaveBeenCalled();
    },
  );

  it("requires an explicit Gmail choice when several user accounts are connected", async () => {
    const client = clientFixture();
    client.recipeCatalog.mockResolvedValue({ ...recipeCatalog, skills: [...recipeCatalog.skills,
      { id: "matrix-jev-email-triage", name: "Jev email triage", description: "Classify mail." }] });
    const onStartChat = vi.fn();
    render(<ChatAgentsWorkspace><ChatAgentsRailSection client={client} onStartChat={onStartChat} />
      <ChatAgentsContent client={client} scopeKey="chat_one"><p>Chat canvas</p></ChatAgentsContent></ChatAgentsWorkspace>);
    fireEvent.click(await screen.findByRole("button", { name: "Browse agent recipes" }));
    const useJev = await screen.findByRole("button", { name: "Use Jev Inbox Triage" });
    expect((useJev as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("combobox", { name: "Gmail account for Jev" }), { target: { value: "Personal" } });
    expect((useJev as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(useJev);
    await waitFor(() => expect(client.create).toHaveBeenCalledTimes(1));
    expect(client.create.mock.calls[0]![0].recipe?.integrations).toEqual([{ service: "gmail", accountLabel: "Personal" }]);
  });

  it("explains the Agent capacity limit before offering the Jev recipe", async () => {
    const client = clientFixture();
    client.list.mockResolvedValue({ enabled: true, agents: Array.from({ length: 100 }, (_, index) => ({
      ...saved, id: `agent_${index}`,
    })) });
    render(<ChatAgentsWorkspace><ChatAgentsRailSection client={client} onStartChat={vi.fn()} />
      <ChatAgentsContent client={client} scopeKey="chat_one"><p>Chat canvas</p></ChatAgentsContent></ChatAgentsWorkspace>);
    fireEvent.click(await screen.findByRole("button", { name: "Browse agent recipes" }));
    const useJev = await screen.findByRole("button", { name: "Use Jev Inbox Triage" });
    expect((useJev as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/100.Agent limit/)).toBeTruthy();
  });

  it("does not open Chat if the Jev bot is absent from the current user's readback", async () => {
    const client = clientFixture();
    client.integrations.mockResolvedValue([{ service: "gmail", account_label: "Mine", account_email: "mine@example.test", status: "active" }]);
    client.recipeCatalog.mockResolvedValue({ ...recipeCatalog, skills: [...recipeCatalog.skills,
      { id: "matrix-jev-email-triage", name: "Jev email triage", description: "Classify mail." }] });
    const onStartChat = vi.fn();
    render(<ChatAgentsWorkspace><ChatAgentsRailSection client={client} onStartChat={onStartChat} />
      <ChatAgentsContent client={client} scopeKey="chat_one"><p>Chat canvas</p></ChatAgentsContent></ChatAgentsWorkspace>);
    fireEvent.click(await screen.findByRole("button", { name: "Browse agent recipes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use Jev Inbox Triage" }));
    await waitFor(() => expect(client.create).toHaveBeenCalledTimes(1));
    expect(onStartChat).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("could not be verified"));
    fireEvent.click(screen.getByRole("button", { name: "Use Jev Inbox Triage" }));
    await waitFor(() => expect(client.create).toHaveBeenCalledTimes(2));
    expect(client.create.mock.calls[1]![0].clientRequestId).toBe(client.create.mock.calls[0]![0].clientRequestId);
  });
  it("replaces only the main pane and restores the same Chat draft and keyboard focus", async () => {
    render(<ChatAgentsEntry client={clientFixture()} />);
    const draft = screen.getByRole("textbox", { name: "Chat draft" });
    fireEvent.change(draft, { target: { value: "Keep this unsent text" } });
    const launcher = await screen.findByRole("button", { name: "Agents" });
    fireEvent.click(launcher);
    expect(screen.queryByRole("textbox", { name: "Chat draft" })).toBeNull();
    expect(draft.isConnected).toBe(true);
    expect(screen.getByRole("region", { name: "Agents" }).closest("main")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Agents" }));
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Unsent Agent" } });
    fireEvent.click(screen.getByRole("button", { name: "Back to Chat" }));
    expect(screen.getByRole("textbox", { name: "Chat draft" })).toBe(draft);
    expect((draft as HTMLTextAreaElement).value).toBe("Keep this unsent text");
    expect(document.activeElement).toBe(launcher);
  });

  it("leaves Agents when the host navigates to another Chat", async () => {
    const client = clientFixture();
    const view = render(<ChatAgentsEntry client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));
    await screen.findByRole("button", { name: "New Agent" });
    view.rerender(<ChatAgentsEntry client={client} scopeKey="chat_two" />);
    expect(screen.queryByRole("region", { name: "Agents" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Chat draft" })).toBeTruthy();
  });

  it("does not display the old account's Agent editor after a runtime switch", async () => {
    const client = clientFixture();
    const view = render(<ChatAgentsEntry client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Private draft" } });
    view.rerender(<ChatAgentsEntry client={clientFixture()} />);
    expect(screen.queryByRole("region", { name: "Agents" })).toBeNull();
    expect(screen.queryByDisplayValue("Private draft")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("");
  });
  it("opens Agents as page content without a modal", async () => {
    render(<ChatAgentsEntry client={clientFixture()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));
    await screen.findByRole("button", { name: "New Agent" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("region", { name: "Agents" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to Chat" })).toBeTruthy();
  });
  it("keeps the Agents page and editor controls styled with native Web tokens", async () => {
    const client = clientFixture();
    render(<ChatAgentsEntry client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));
    const content = screen.getByRole("region", { name: "Agents" });
    expect(content.style.background).toBe("var(--bg-surface, var(--matrix-card, var(--card)))");
    expect(content.style.color).toBe("var(--text-primary, var(--matrix-card-fg, var(--foreground)))");
    expect(content.style.border).toBe("1px solid var(--border-default, var(--matrix-border, var(--border)))");
    expect((await screen.findByText(/Create specialists/)).getAttribute("style")).toContain("var(--muted-foreground)");
    const newAgent = await screen.findByRole("button", { name: "New Agent" });
    expect(newAgent.className).toContain("hover:enabled:bg-[var(--bg-hover,var(--matrix-secondary,var(--secondary)))]");
    expect(newAgent.className).toContain("focus-visible:ring-[var(--ring,var(--accent,var(--matrix-accent,var(--matrix-ring))))]");
  });

  it("keeps a long saved name inspectable in its acknowledgement and library row", async () => {
    const client = clientFixture();
    const name = "A".repeat(80);
    render(<ChatAgentsEntry client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: name } });
    fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "Help" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    const notice = await screen.findByRole("status");
    expect(notice.title).toContain(name);
    fireEvent.click(await screen.findByRole("button", { name: `Edit ${name}` }));
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe(name);
  });

  it("presents saved Agents as recognizable collaborators with capability context", async () => {
    const client = clientFixture();
    client.list.mockResolvedValue({ enabled: true, agents: [{ ...saved, recipe: {
      skills: ["matrix-integrations", "matrix-personal-daily-brief"],
      integrations: [{ service: "gmail", accountLabel: "Work" }, { service: "google_calendar", accountLabel: "Calendar" }],
      output: "A concise daily brief.",
    } }] });
    render(<ChatAgentsEntry client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));

    const row = await screen.findByRole("button", { name: "Edit Meeting helper" });
    expect(row.querySelector('[data-agent-avatar="bot_meeting01"]')).toBeTruthy();
    expect(row.querySelector('[data-agent-avatar="bot_meeting01"]')?.getAttribute("data-rabbit-state")).toBe("idle");
    expect(row.textContent).toContain("Ready to mention");
    expect(row.textContent).toContain("2 skills · 2 integrations");
  });

  it("presents the library as a polished AI team workspace with clear starter and roster hierarchy", async () => {
    const client = clientFixture();
    client.list.mockResolvedValue({ enabled: true, agents: [saved] });
    render(<ChatAgentsEntry client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));

    const surface = screen.getByRole("region", { name: "Agents" });
    expect(surface.getAttribute("data-agent-surface")).toBe("library");
    expect(surface.className).toContain("matrix-chat-agents-panel");
    expect(await screen.findByRole("heading", { name: "Your AI team" })).toBeTruthy();
    expect(screen.getByText("Build your team")).toBeTruthy();

    const template = await screen.findByRole("button", { name: "Personal Daily Brief" });
    expect(template.getAttribute("data-agent-template")).toBe("daily-brief");
    expect(template.className).toContain("matrix-chat-agent-card");

    const savedAgent = screen.getByRole("button", { name: "Edit Meeting helper" });
    expect(savedAgent.getAttribute("data-agent-card")).toBe("saved");
    expect(savedAgent.className).toContain("matrix-chat-agent-card");
    expect(savedAgent.querySelector(".matrix-chat-agent-card__content")).toBeTruthy();
    expect(savedAgent.textContent).toContain("@Meeting helper");
  });


  it("omits an unchanged unavailable model for a recipe-only edit", async () => {
    const client = clientFixture();
    client.list.mockResolvedValue({ enabled: true, agents: [saved] });
    client.catalog.mockResolvedValue(createCanonicalProviderCatalogFixture());
    render(<ChatAgentsEntry client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit Meeting helper" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add recipe" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Expected output" }), { target: { value: "Edited brief" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(client.update).toHaveBeenCalledTimes(1));
    expect(client.update.mock.calls[0]![1]).not.toHaveProperty("selection");
    expect(client.update.mock.calls[0]![1]).toMatchObject({ recipe: { output: "Edited brief" } });
  });

  it("preserves selections when refreshed skills become too large and requires reducing the combination before saving", async () => {
    const client = clientFixture();
    client.list.mockResolvedValue({ enabled: true, agents: [{ ...saved, recipe: {
      skills: ["matrix-integrations", "matrix-personal-daily-brief"], integrations: [], output: "Daily report",
    } }] });
    client.recipeCatalog.mockResolvedValue({ ...recipeCatalog, skills: recipeCatalog.skills.map((skill) => ({ ...skill, instructionBytes: 8_000 })) });
    render(<ChatAgentsEntry client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit Meeting helper" }));
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(false);
    client.recipeCatalog.mockResolvedValue({ ...recipeCatalog, skills: recipeCatalog.skills.map((skill) => ({ ...skill, instructionBytes: 16_000 })) });
    fireEvent.click(screen.getByRole("button", { name: "Refresh skills" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText("These skills are too large to use together. Remove a selected skill.")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "Matrix integrations" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Personal Daily Brief" }));
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("explains duplicate account rows and allows correcting the pair", async () => {
    const client = clientFixture();
    render(<ChatAgentsEntry client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));
    fireEvent.click(await screen.findByRole("button", { name: "Personal Daily Brief" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Add integration" }), { target: { value: "gmail" } });
    expect(screen.getAllByRole("combobox", { name: "Gmail account" })).toHaveLength(2);
    expect(screen.getAllByText("Choose a different account or remove this duplicate integration.").length).toBeGreaterThan(0);
    expect((screen.getByRole("button", { name: "Create Agent" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getAllByRole("combobox", { name: "Gmail account" })[1]!, { target: { value: "Work" } });
    expect(screen.queryByText("Choose a different account or remove this duplicate integration.")).toBeNull();
    expect((screen.getByRole("button", { name: "Create Agent" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove Gmail" })[0]!);
    expect((screen.getByRole("combobox", { name: "Gmail account" }) as HTMLSelectElement).value).toBe("Work");
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    await waitFor(() => expect(client.create).toHaveBeenCalledTimes(1));
    expect(client.create.mock.calls[0]![0].recipe?.integrations).toEqual([
      { service: "google_calendar", accountLabel: "Calendar" }, { service: "gmail", accountLabel: "Work" },
    ]);
  });

  it("keeps the existing Chat mounted and creates a saved role without executing it", async () => {
    const client = clientFixture();
    render(<><textarea aria-label="Existing draft" defaultValue="Keep this original draft" /><ChatAgentsEntry client={client} /></>);
    const editor = screen.getByRole("textbox", { name: "Existing draft" });
    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Meeting helper" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "Summarize decisions." } });
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    await waitFor(() => expect(client.create).toHaveBeenCalledTimes(1));
    expect(client.create.mock.calls[0]![0]).toMatchObject({ name: saved.name, instructions: saved.instructions, selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" } });
    expect((await screen.findByRole("status")).textContent).toContain("@Meeting helper");
    fireEvent.click(screen.getByRole("button", { name: "Back to Chat" }));
    expect(screen.getByRole("textbox", { name: "Existing draft" })).toBe(editor);
    expect((editor as HTMLTextAreaElement).value).toBe("Keep this original draft");
  });
  it("prefills and saves the Personal Daily Brief recipe with deliberate account selection", async () => {
    const client = clientFixture();
    render(<ChatAgentsEntry client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));
    fireEvent.click(await screen.findByRole("button", { name: "Personal Daily Brief" }));

    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Personal Daily Brief");
    expect((screen.getByRole("textbox", { name: "Description Optional" }) as HTMLInputElement).value)
      .toContain("email and calendar");
    expect((screen.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value)
      .toContain("daily brief");
    expect((screen.getByRole("checkbox", { name: "Matrix integrations" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Personal Daily Brief" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("combobox", { name: "Gmail account" }) as HTMLSelectElement).value).toBe("");
    expect((screen.getByRole("combobox", { name: "Google Calendar account" }) as HTMLSelectElement).value).toBe("Calendar");

    fireEvent.change(screen.getByRole("combobox", { name: "Gmail account" }), { target: { value: "Work" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    await waitFor(() => expect(client.create).toHaveBeenCalledTimes(1));
    expect(client.create.mock.calls[0]![0]).toMatchObject({
      name: "Personal Daily Brief",
      recipe: {
        skills: ["matrix-personal-daily-brief", "matrix-integrations"],
        integrations: [
          { service: "gmail", accountLabel: "Work" },
          { service: "google_calendar", accountLabel: "Calendar" },
        ],
        output: "An English daily brief with today's schedule, actionable follow-ups, top priorities, source links or IDs, and data gaps.",
      },
    });
    expect(client.update).not.toHaveBeenCalled();
  });
  it("round-trips account choices and preserves a removed saved account as unavailable", async () => {
    const client = clientFixture();
    const recipeAgent = { ...saved, recipe: {
      skills: ["matrix-integrations" as const],
      integrations: [{ service: "gmail", accountLabel: "Former account" }],
      output: "A concise source-backed summary.",
    } };
    client.list.mockResolvedValue({ enabled: true, agents: [recipeAgent] });
    client.recipeCatalog.mockResolvedValue({ ...recipeCatalog,
      services: [{ id: "google_calendar", name: "Google Calendar" }] });
    render(<ChatAgentsEntry client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit Meeting helper" }));

    const account = screen.getByRole("combobox", { name: "Gmail account" }) as HTMLSelectElement;
    expect(screen.getByText("Gmail · unavailable")).toBeTruthy();
    expect(account.value).toBe("Former account");
    expect(screen.getByRole("option", { name: "Former account · unavailable" })).toBeTruthy();
    fireEvent.change(account, { target: { value: "Personal" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(client.update).toHaveBeenCalledTimes(1));
    expect(client.update.mock.calls[0]![1]).toMatchObject({
      recipe: { integrations: [{ service: "gmail", accountLabel: "Personal" }] },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Edit Meeting helper" }));
    expect((screen.getByRole("combobox", { name: "Gmail account" }) as HTMLSelectElement).value).toBe("Personal");
  });
  it("keeps the draft and old Agents available while recipe metadata retries", async () => {
    const client = clientFixture();
    client.list.mockResolvedValue({ enabled: true, agents: [saved] });
    client.recipeCatalog.mockRejectedValueOnce(new Error("private capability failure"));
    client.integrations.mockRejectedValueOnce(new Error("private connection failure"));
    render(<ChatAgentsEntry client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));
    expect(await screen.findByRole("button", { name: "Edit Meeting helper" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New Agent" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Keep this draft" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "Keep these instructions." } });
    expect(await screen.findByText("Recipe options are unavailable.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Retry recipe options" }));
    await waitFor(() => expect(client.recipeCatalog).toHaveBeenCalledTimes(2));
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Keep this draft");
    expect((screen.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value).toBe("Keep these instructions.");
    expect(await screen.findByRole("button", { name: "Add recipe" })).toBeTruthy();
  });
  it("keeps recipe capabilities available when connection status cannot be loaded", async () => {
    const client = clientFixture();
    client.list.mockResolvedValue({ enabled: true, agents: [{ ...saved, recipe: {
      skills: ["matrix-integrations" as const],
      integrations: [{ service: "gmail", accountLabel: "Work" }],
      output: "A concise source-backed summary.",
    } }] });
    client.integrations.mockRejectedValueOnce(new Error("private connection failure"));
    render(<ChatAgentsEntry client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit Meeting helper" }));
    expect((screen.getByRole("combobox", { name: "Gmail account" }) as HTMLSelectElement).value).toBe("Work");
    expect(screen.getByRole("option", { name: "Work · status unavailable" })).toBeTruthy();
    expect(screen.getByText("Account status could not be verified. Your saved choice is preserved.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(await screen.findByRole("button", { name: "Personal Daily Brief" }));

    expect(screen.getByText("Connection status is unavailable. Saved account choices are preserved.")).toBeTruthy();
    expect(screen.queryByText(/No connected account/)).toBeNull();
    expect(screen.getAllByText("Account status could not be verified. Keep Ask when run or retry.")).toHaveLength(2);
    expect((screen.getByRole("combobox", { name: "Gmail account" }) as HTMLSelectElement).value).toBe("");
    expect((screen.getByRole("combobox", { name: "Google Calendar account" }) as HTMLSelectElement).value).toBe("");
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Personal Daily Brief");
  });
  it("updates an old Agent without adding or clearing recipe configuration", async () => {
    const client = clientFixture();
    client.list.mockResolvedValue({ enabled: true, agents: [saved] });
    render(<ChatAgentsEntry client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit Meeting helper" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add recipe" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove recipe" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Description Optional" }), { target: { value: "Updated description" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(client.update).toHaveBeenCalledTimes(1));
    expect(client.update.mock.calls[0]![1]).not.toHaveProperty("recipe");
  });
  it("sends recipe null only when removing an existing saved recipe", async () => {
    const client = clientFixture();
    const recipeAgent = { ...saved, recipe: {
      skills: ["matrix-integrations" as const], integrations: [{ service: "gmail", accountLabel: "Work" }],
      output: "A concise source-backed summary.",
    } };
    client.list.mockResolvedValue({ enabled: true, agents: [recipeAgent] });
    render(<ChatAgentsEntry client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit Meeting helper" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove recipe" }));
    expect(screen.getByText("This saved recipe will be removed when you save.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(client.update).toHaveBeenCalledTimes(1));
    expect(client.update.mock.calls[0]![1]).toMatchObject({ recipe: null });
  });
  it("preserves form input and shows only safe copy after a failed save", async () => {
    const client = clientFixture();
    client.create.mockRejectedValueOnce(new Error("/opt/private/database postgres failure"));
    render(<ChatAgentsEntry client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "My helper" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "Keep my instructions" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    expect((await screen.findByRole("alert")).textContent).not.toContain("postgres");
    expect((screen.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value).toBe("Keep my instructions");
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    await waitFor(() => expect(client.create).toHaveBeenCalledTimes(2));
    expect(client.create.mock.calls[0]![0].clientRequestId).toBe(client.create.mock.calls[1]![0].clientRequestId);
  });
  it("hides the entry with the switch off", async () => {
    const client = clientFixture(); client.list.mockResolvedValue({ enabled: false, agents: [] });
    render(<ChatAgentsEntry client={client} />);
    await waitFor(() => expect(client.list).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Agents" })).toBeNull();
  });
  it("retains an Agent in the list when archival fails", async () => {
    const client = clientFixture(); client.list.mockResolvedValue({ enabled: true, agents: [saved] });
    client.update.mockRejectedValue(new Error("private internal failure"));
    render(<ChatAgentsEntry client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit Meeting helper" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive Agent" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe(saved.name);
  });
});

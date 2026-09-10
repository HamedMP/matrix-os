// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatAgentsEntry as AgentsLauncher } from "../../packages/ui/src/chat-agents/ChatAgentsEntry.js";
import { ChatAgentsWorkspace } from "../../packages/ui/src/chat-agents/ChatAgentsNavigation.js";
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
afterEach(cleanup);

describe("shared Agents entry", () => {
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
    expect(content.style.border).toContain("var(--border-default, var(--matrix-border, var(--border)))");
    expect(screen.getByText(/Save a role/).getAttribute("style")).toContain("var(--muted-foreground)");
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
    expect(client.create.mock.calls[0]![0]).toMatchObject({ name: saved.name, instructions: saved.instructions, selection: saved.selection });
    expect(await screen.findByText(/@Meeting helper/)).toBeTruthy();
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

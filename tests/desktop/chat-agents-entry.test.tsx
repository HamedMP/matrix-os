// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatAgentsEntry } from "../../packages/ui/src/chat-agents/ChatAgentsEntry.js";
import type { ChatAgentClient } from "../../packages/ui/src/chat-agents/client.js";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";

const saved = { id: "bot_meeting01", revision: 1, name: "Meeting helper", description: "Prepare meetings",
  instructions: "Summarize decisions.", selection: { instanceId: "hermes_default", model: "openai:gpt-5.6-sol" },
  archived: false, createdAt: "2026-09-10T00:00:00.000Z", updatedAt: "2026-09-10T00:00:00.000Z" };
const recipeCatalog = {
  enabled: true,
  skills: [
    { id: "matrix-integrations" as const, name: "Matrix integrations", description: "Use connected Matrix integrations." },
    { id: "matrix-personal-daily-brief" as const, name: "Personal Daily Brief", description: "Prepare a source-backed daily brief." },
  ],
  services: [
    { id: "gmail", name: "Gmail" },
    { id: "google_calendar", name: "Google Calendar" },
  ],
};
const connections = [
  { service: "gmail", account_label: "Work", account_email: "work@example.test", status: "active" },
  { service: "gmail", account_label: "Personal", account_email: "personal@example.test", status: "active" },
  { service: "google_calendar", account_label: "Calendar", account_email: "calendar@example.test", status: "active" },
];
function clientFixture() {
  const catalog = createCanonicalProviderCatalogFixture();
  catalog.instances.push({ ...catalog.instances[0]!, id: "hermes_default", driverKind: "hermes",
    models: [{ ...catalog.instances[0]!.models[0]!, id: saved.selection.model }],
  });
  const client = {
    list: vi.fn(async () => ({ enabled: true, agents: [] })),
    catalog: vi.fn(async () => catalog),
    recipeCatalog: vi.fn(async () => recipeCatalog),
    integrations: vi.fn(async () => connections),
    create: vi.fn(async (input) => ({ ...saved, name: input.name, description: input.description,
      instructions: input.instructions, selection: input.selection, ...(input.recipe ? { recipe: input.recipe } : {}) })),
    update: vi.fn(async (_id, input) => ({ ...saved, revision: 2,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
      ...(input.selection === undefined ? {} : { selection: input.selection }),
      ...(input.recipe === undefined ? {} : input.recipe === null ? {} : { recipe: input.recipe }),
    })),
    search: vi.fn(async () => ({ enabled: true, resources: [] })), preview: vi.fn(),
  } satisfies ChatAgentClient;
  return client;
}
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(cleanup);

describe("shared Agents entry", () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Close Agents" }));
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

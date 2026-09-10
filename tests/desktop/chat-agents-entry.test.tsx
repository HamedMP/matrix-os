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
function clientFixture() {
  const catalog = createCanonicalProviderCatalogFixture();
  catalog.instances.push({ ...catalog.instances[0]!, id: "hermes_default", driverKind: "hermes",
    models: [{ ...catalog.instances[0]!.models[0]!, id: saved.selection.model }],
  });
  return {
    list: vi.fn(async () => ({ enabled: true, agents: [] })),
    catalog: vi.fn(async () => catalog), create: vi.fn(async () => saved), update: vi.fn(),
    search: vi.fn(async () => ({ enabled: true, resources: [] })), preview: vi.fn(),
  } satisfies ChatAgentClient;
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

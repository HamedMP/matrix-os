// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BotsWorkspace } from "../../packages/ui/src/bots/BotsWorkspace";
import { useHostedBotsAvailability, type HostedBotsTransport } from "../../packages/ui/src/bots/hosted-bots-client";

const bot = { id: "bot-1", name: "Pebble", description: "", revision: 0, instructions: "" };
const thread = { id: "thread-1", title: "New conversation", updatedAt: "2026-11-10T01:00:00.000Z" };
const run = { id: "run-1", status: "queued", mode: "setup", createdAt: "2026-11-10T01:01:00.000Z", completedAt: null };

afterEach(cleanup);

describe("hosted Bots", () => {
  it("creates a bot, opens a conversation and sends the first turn in setup mode", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/api/hosted-bots") return { bots: [] };
      if (path === "/api/hosted-bots/model") return { connected: true };
      if (path === "/api/hosted-bots/bot-1") return { bot, threads: [] };
      return { thread, messages: [], runs: [], profileChanges: [] };
    });
    const post = vi.fn(async (path: string) => {
      if (path === "/api/hosted-bots") return { bot };
      if (path.endsWith("/threads")) return { thread };
      return { run };
    });
    render(<BotsWorkspace transport={{ get, post, put: vi.fn() }} active />);

    fireEvent.click(await screen.findByRole("button", { name: "New Bot" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Bot name" }), { target: { value: "Pebble" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Bot" }));
    const composer = await screen.findByRole("textbox", { name: "Message Pebble" });
    fireEvent.change(composer, { target: { value: "Use a short greeting." } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(post).toHaveBeenCalledWith(
      "/api/hosted-bots/bot-1/threads/thread-1/runs",
      { requestId: expect.any(String), text: "Use a short greeting.", mode: "setup" },
    ));
  });

  it("opens a saved thread and offers undo for the latest saved configuration", async () => {
    const configured = { ...bot, revision: 2, instructions: "Use a short greeting." };
    const change = { id: "change-new", reason: "Set greeting", revision: 2, undoneAt: null };
    const get = vi.fn(async (path: string) => {
      if (path === "/api/hosted-bots") return { bots: [bot] };
      if (path === "/api/hosted-bots/model") return { connected: true };
      if (path === "/api/hosted-bots/bot-1") return { bot: configured, threads: [thread] };
      return {
        thread,
        messages: [{ id: "msg-1", role: "assistant", text: "A persisted reply.", createdAt: thread.updatedAt }],
        runs: [{ ...run, status: "completed", completedAt: thread.updatedAt }],
        profileChanges: [change, { ...change, id: "change-old", revision: 1 }],
      };
    });
    const post = vi.fn(async () => ({ bot: { ...configured, revision: 3 } }));
    render(<BotsWorkspace transport={{ get, post, put: vi.fn() }} active />);

    fireEvent.click(await screen.findByRole("button", { name: "Pebble" }));
    expect(await screen.findByText("A persisted reply.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Configure in chat" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(
      "/api/hosted-bots/bot-1/profile-changes/change-new/undo",
      {},
    ));
  });

  it("rechecks admission on computer change and hides the entry on malformed or unavailable responses", async () => {
    function Admission({ transport }: { transport: HostedBotsTransport }) {
      return <span>{useHostedBotsAvailability(transport) ? "Bots available" : "Bots unavailable"}</span>;
    }
    const post = vi.fn();
    const put = vi.fn();
    const first = { get: vi.fn().mockResolvedValue({ bots: [] }), post, put };
    const other = { get: vi.fn().mockResolvedValue({ bots: null }), post, put };
    const view = render(<Admission transport={first} />);
    expect(await screen.findByText("Bots available")).toBeTruthy();
    view.rerender(<Admission transport={other} />);
    expect(screen.getByText("Bots unavailable")).toBeTruthy();
    await waitFor(() => expect(other.get).toHaveBeenCalledWith("/api/hosted-bots"));
    expect(screen.queryByText("Bots available")).toBeNull();
  });
});

// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MessageBoard } from "../../packages/ui/src/message-board/MessageBoard";
import { createLiveBoard } from "./message-board-harness";

// Fault detected: the shipped viewer and the gateway disagree on a route, a body or a response shape.
describe("Message Board viewer against the real board routes", () => {
  let live: Awaited<ReturnType<typeof createLiveBoard>>;
  let runtime: Awaited<ReturnType<typeof createLiveBoard>>["runtime"];

  beforeEach(async () => {
    live = await createLiveBoard();
    runtime = live.runtime;
  });

  afterEach(async () => {
    cleanup();
    await live.close();
  });

  const renderLive = () => render(<MessageBoard client={live.client} />);

  it("starts empty, posts a task, claims it and completes it", async () => {
    renderLive();
    fireEvent.click(await screen.findByRole("button", { name: "Post a message" }));
    const form = await screen.findByRole("region", { name: "New thread" });
    fireEvent.change(within(form).getByRole("textbox", { name: "New channel path" }), { target: { value: "dev" } });
    fireEvent.click(within(form).getByRole("button", { name: /Make this a task/ }));
    const text = within(form).getByRole("textbox", { name: "Message" });
    fireEvent.change(text, { target: { value: "Fix flaky login test" } });
    fireEvent.keyDown(text, { key: "Enter" });

    const task = await screen.findByRole("region", { name: "Board task" });
    fireEvent.click(await within(task).findByRole("button", { name: "Claim" }));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Board task" })).getByRole("button", { name: "Complete" })).toBeInTheDocument());
    fireEvent.click(within(screen.getByRole("region", { name: "Board task" })).getByRole("button", { name: "Complete" }));
    const result = await screen.findByRole("textbox", { name: "Result (optional)" });
    fireEvent.change(result, { target: { value: "Merged #3501" } });
    fireEvent.click(within(screen.getByRole("region", { name: "Board task" })).getAllByRole("button", { name: "Complete" }).at(-1)!);

    await waitFor(async () => {
      const [thread] = await runtime.service.listThreads({ ownerId: "owner_1", actor: { id: "user:owner_1", kind: "user", name: "You" } }, undefined, { channel: "dev" });
      expect(thread?.task).toMatchObject({ state: "completed", result: "Merged #3501" });
    });
    expect(await screen.findByText("Merged #3501", {}, { timeout: 3_000 })).toBeInTheDocument();
  });

  it("shows replies posted by agents after a reload", async () => {
    const agent = { ownerId: "owner_1", actor: { id: "agent:tws_1.tt_2", kind: "agent" as const, name: "terminal tt_2", profile: "fixer" } };
    const root = await runtime.service.post(agent, undefined, { channel: "security/findings", text: "Token in a debug log" });
    renderLive();
    fireEvent.click(await screen.findByRole("button", { name: /Token in a debug log/ }));
    expect(await screen.findByText("fixer via terminal tt_2")).toBeInTheDocument();
    const reply = await screen.findByRole("textbox", { name: "Reply" });
    fireEvent.change(reply, { target: { value: "Rotating it now" } });
    fireEvent.keyDown(reply, { key: "Enter" });
    expect(await screen.findByText("Rotating it now")).toBeInTheDocument();
    const thread = await runtime.service.getThread(agent, undefined, root.id);
    expect(thread.replies.map((item) => item.text)).toEqual(["Rotating it now"]);
  });

  it("pauses a watcher and cancels a schedule from the Automation panels", async () => {
    const owner = { ownerId: "owner_1", actor: { id: "user:owner_1", kind: "user" as const, name: "You" } };
    await runtime.service.post(owner, undefined, { channel: "incidents", text: "Seed" });
    const watcher = await runtime.watchers.create(owner, undefined, { name: "incident-triage", tail: { channel: "incidents" }, action: { kind: "start", template: "incident-responder" } });
    await runtime.schedules.create(owner, undefined, { channel: "incidents", text: "Weekly summary", in: "1h", every: "7d" });
    renderLive();
    fireEvent.click(await screen.findByRole("button", { name: "Watchers" }));
    fireEvent.click(await screen.findByRole("switch", { name: "Pause incident-triage" }));
    await waitFor(async () => expect((await runtime.watchers.list(owner, undefined))[0]).toMatchObject({ id: watcher.id, enabled: false }));
    fireEvent.click(screen.getByRole("button", { name: "Schedules" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel schedule" }));
    await waitFor(async () => expect(await runtime.schedules.list(owner, undefined)).toEqual([]));
  });
});

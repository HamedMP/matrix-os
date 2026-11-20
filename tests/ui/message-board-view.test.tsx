// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MessageBoard } from "../../packages/ui/src/message-board/MessageBoard";
import { createLiveBoard, FIXER, OWNER } from "./message-board-harness";

let live: Awaited<ReturnType<typeof createLiveBoard>>;

beforeEach(async () => { live = await createLiveBoard(); });

afterEach(async () => {
  cleanup();
  Reflect.deleteProperty(globalThis, "ResizeObserver");
  await live.close();
});

async function seed() {
  const { runtime, as } = live;
  const post = (channel: string, text: string) => runtime.service.post(as(OWNER), undefined, { channel, text });
  await post("security/findings", "Dependency audit: 2 moderate advisories");
  await post("security/findings", "Token appeared in a debug log");
  await post("security/triage", "CSP report spike");
  await runtime.tasks.create(as(OWNER), undefined, { channel: "security/triage", text: "Weekly triage summary" });
  const flaky = await runtime.tasks.create(as(OWNER), undefined, { channel: "dev", text: "Fix flaky login test", labels: { kind: "bug" } });
  await runtime.tasks.create(as(OWNER), undefined, { channel: "dev", text: "Bump node to 24.3", labels: { kind: "chore" } });
  const blocked = await runtime.tasks.create(as(OWNER), undefined, { channel: "incidents", text: "Disk usage over 85%" });
  await runtime.tasks.block(as(OWNER), undefined, blocked.root.id, { reason: "Need approval", kind: "needs_input" });
  await runtime.tasks.claim(as(FIXER), undefined, { id: flaky.root.id });
  await post("dev", "Deploy notes for 0.42");
}

describe("MessageBoard viewer", () => {
  it("shows the onboarding empty state with a post action and a CLI command", async () => {
    render(<MessageBoard client={live.client} />);
    expect(await screen.findByText("Nothing posted yet")).toBeInTheDocument();
    expect(screen.getByText('matrix board post dev "Login test is flaky"')).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Post a message" }));
    expect(await screen.findByRole("region", { name: "New thread" })).toBeInTheDocument();
  });

  it("groups channels by prefix and narrows the thread list to a subtree", async () => {
    await seed();
    render(<MessageBoard client={live.client} />);
    const nav = await screen.findByRole("navigation", { name: "Channels" });
    fireEvent.click(await within(nav).findByRole("button", { name: /^security\// }));
    const list = await screen.findByRole("list", { name: "Threads" });
    await waitFor(() => expect(within(list).getAllByRole("button")).toHaveLength(4));
    expect(within(list).getByRole("button", { name: /Dependency audit/ })).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: /Fix flaky login test/ })).toBeNull();
  });

  it("shows the Tasks view as a queue grouped by state", async () => {
    await seed();
    render(<MessageBoard client={live.client} />);
    await screen.findByRole("list", { name: "Threads" });
    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    expect(await screen.findByRole("region", { name: "Ready tasks" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Blocked tasks" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Claimed tasks" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Deploy notes for 0.42/ })).toBeNull();
  });

  it("opens a claimed task with its holder and lease, and lets a person claim a ready task", async () => {
    await seed();
    render(<MessageBoard client={live.client} />);
    fireEvent.click(await screen.findByRole("button", { name: /Fix flaky login test, Claimed/ }));
    const task = await screen.findByRole("region", { name: "Board task" });
    expect(await within(task).findByText("fixer via terminal fixer")).toBeInTheDocument();
    expect(within(task).getByLabelText(/Lease ends in \d+:\d\d/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Bump node to 24.3, Ready/ }));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Board task" })).getByRole("button", { name: "Claim" })).toBeInTheDocument());
    fireEvent.click(within(screen.getByRole("region", { name: "Board task" })).getByRole("button", { name: "Claim" }));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Board task" })).getByRole("button", { name: "Complete" })).toBeInTheDocument());
  });

  it("replies, filters by label, and shows a generic error when the board is unreachable", async () => {
    await seed();
    render(<MessageBoard client={live.client} />);
    fireEvent.click(await screen.findByRole("button", { name: /Deploy notes for 0.42/ }));
    const reply = await screen.findByRole("textbox", { name: "Reply" });
    fireEvent.change(reply, { target: { value: "Promoting to canary" } });
    fireEvent.keyDown(reply, { key: "Enter" });
    expect(await screen.findByText("Promoting to canary")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: /Filter by label/ }), { target: { value: "kind=bug|chore" } });
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Threads" })).getAllByRole("button")).toHaveLength(2));

    live.state.failing = true;
    fireEvent.change(reply, { target: { value: "Will fail" } });
    fireEvent.keyDown(reply, { key: "Enter" });
    expect((await screen.findAllByText("The board is not reachable right now. Try again.")).length).toBeGreaterThan(0);
    expect(reply).toHaveValue("Will fail");
  });

  it("shows the Tasks empty state for a channel without tasks and explains a failed conversion", async () => {
    await live.runtime.service.post(live.as(OWNER), undefined, { channel: "notes", text: "Plain note" });
    render(<MessageBoard client={live.client} />);
    fireEvent.click(await screen.findByRole("button", { name: /Plain note/ }));
    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    expect(await screen.findByText("No tasks here")).toBeInTheDocument();
    live.state.failing = true;
    fireEvent.click(await screen.findByRole("button", { name: /Make this a task/ }));
    expect((await screen.findAllByText("The board is not reachable right now. Try again.")).length).toBeGreaterThan(0);
  });

  it("refuses to overwrite an edit made elsewhere since the editor opened", async () => {
    const root = await live.runtime.service.post(live.as(OWNER), undefined, { channel: "dev", text: "Draft one" });
    render(<MessageBoard client={live.client} />);
    fireEvent.click(await screen.findByRole("button", { name: /Draft one/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit message" }));
    await live.runtime.service.edit(live.as(OWNER), undefined, root.id, { text: "Edited in another tab" });
    const editor = await screen.findByRole("textbox", { name: "Edit message" });
    fireEvent.change(editor, { target: { value: "Stale draft" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(await screen.findByText("This message changed since you opened it. Close the editor and try again.")).toBeInTheDocument();
    expect((await live.runtime.service.getThread(live.as(OWNER), undefined, root.id)).root.text).toBe("Edited in another tab");
  });

  it("marks a reply read when it arrives while its thread is on screen", async () => {
    const root = await live.runtime.service.post(live.as(OWNER), undefined, { channel: "dev", text: "Watching this" });
    render(<MessageBoard client={live.client} />);
    fireEvent.click(await screen.findByRole("button", { name: /Watching this/ }));
    await screen.findByRole("textbox", { name: "Reply" });
    await live.runtime.service.post(live.as(FIXER), undefined, { channel: "dev", text: "New progress", re: root.id });
    // Any refresh (here: reacting to the root) brings the reply in while the thread stays open.
    fireEvent.click(screen.getAllByRole("button", { name: "Add reaction" })[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "React with 👀" }));
    await screen.findByText("New progress");
    await waitFor(async () => {
      const [thread] = await live.runtime.service.listThreads(live.as(OWNER), undefined, { channel: "dev" });
      expect(thread!.unread).toBe(false);
    });
  });

  it("explains a failed label removal and never navigates for a post that lands after the form closed", async () => {
    const root = await live.runtime.service.post(live.as(OWNER), undefined, { channel: "dev", text: "Labelled", labels: { kind: "bug" } });
    render(<MessageBoard client={live.client} />);
    fireEvent.click(await screen.findByRole("button", { name: /Labelled/ }));
    live.state.failing = true;
    fireEvent.click(await screen.findByRole("button", { name: "Remove label kind" }));
    expect((await screen.findAllByText("The board is not reachable right now. Try again.")).length).toBeGreaterThan(0);
    live.state.failing = false;
    // Hold the next post until the form is closed.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const post = live.client.post.bind(live.client);
    live.client.post = async (...args) => { await held; return post(...args); };
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    const text = await screen.findByRole("textbox", { name: "Message" });
    fireEvent.change(text, { target: { value: "Late post" } });
    fireEvent.keyDown(text, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Close new thread" }));
    release();
    await waitFor(async () => expect(await live.runtime.service.listMessages(live.as(OWNER), undefined, { text: "Late post" })).toHaveLength(1));
    expect(screen.queryByRole("region", { name: "Thread" })).toBeNull();
    expect(root.id).toBeTruthy();
  });

  it("collapses to one pane with back navigation in a narrow window", async () => {
    class NarrowObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() { this.callback([{ contentRect: { width: 480 } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
      disconnect() {}
      unobserve() {}
    }
    Object.assign(globalThis, { ResizeObserver: NarrowObserver });
    await seed();
    render(<MessageBoard client={live.client} />);
    fireEvent.click(await screen.findByRole("button", { name: /Bump node to 24.3/ }));
    expect(await screen.findByRole("region", { name: "Thread" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Channels" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to threads" }));
    expect(await screen.findByRole("list", { name: "Threads" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to channels" }));
    expect(await screen.findByRole("navigation", { name: "Channels" })).toBeInTheDocument();
    // A thread that fails to load still offers the way back.
    fireEvent.click(screen.getByRole("button", { name: /^dev/ }));
    live.state.failing = true;
    fireEvent.click(await screen.findByRole("button", { name: /Deploy notes for 0.42/ }));
    expect(await screen.findByRole("button", { name: "Back to threads" })).toBeInTheDocument();
  });
});

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { routeIntent } from "../../../../home/apps/mail/src/agent/intent";
import { createMailAgent } from "../../../../home/apps/mail/src/agent/controller";
import { threadKey } from "../../../../home/apps/mail/src/model/ids";
import { GMAIL, message, summary, thread } from "../model/fixtures";
import { harness } from "./helpers";

const k = (id: string) => threadKey(GMAIL.id, id);

describe("routeIntent", () => {
  const open = { hasThread: true, hasSelection: false };
  const none = { hasThread: false, hasSelection: false };
  it.each([
    ["summarise this", open, "summarize"],
    ["reply that Thursday works", open, "reply"],
    ["say yes but ask for the agenda", open, "reply"],
    ["find the contract Dana pushed back on in September", open, "search"],
    ["where is the invoice from Acme?", none, "search"],
    ["write to bob@example.com asking for the Q3 numbers and a call next week", none, "new"],
    ["tidy up these", { hasThread: false, hasSelection: true }, "triage"],
    ["summarise", none, "search"],
  ] as const)("%s -> %s", (text, context, kind) => {
    expect(routeIntent(text, context).kind).toBe(kind);
  });
});

async function setup() {
  return harness((gmail) => {
    gmail.lists.INBOX = [summary("t1"), summary("t2")];
    gmail.threads.t1 = thread("t1", [message("m1", { bodyText: "Can we meet Thursday?" })]);
  });
}

describe("createMailAgent", () => {
  it("routes free text to a reply draft for the open thread and records a reviewable item", async () => {
    const { ctx, ai, store, gmail } = await setup();
    await store.openThread(k("t1"));
    ai.fallback = '{"body":"Thursday works."}';
    const agent = createMailAgent(ctx);
    await agent.ask("say Thursday works");
    const state = agent.getState();
    expect(state.busy).toBe(false);
    expect(state.error).toBeNull();
    expect(state.messages[0]).toMatchObject({ role: "user", text: "say Thursday works" });
    expect(state.items[0].kind).toBe("draft");
    const proposalId = (state.items[0] as { proposalId: string }).proposalId;
    expect(ctx.proposals.get(proposalId)?.proposed).toBe("Thursday works.");
    expect(state.status.every((line) => line.state === "done")).toBe(true);
    expect(gmail.calls.sendDraft).toHaveLength(0);
  });

  it("shows an allowlisted error when the task fails", async () => {
    const { ctx, ai } = await setup();
    ai.fallback = "nope";
    const agent = createMailAgent(ctx);
    await agent.summarize(k("t1"));
    expect(agent.getState().error).toBe("The assistant's answer could not be used. Try again.");
    expect(agent.getState().status.at(-1)?.state).toBe("error");
  });

  it("needs an open thread for a reply", async () => {
    const { ctx } = await setup();
    const agent = createMailAgent(ctx);
    await agent.draftReply("hi");
    expect(agent.getState().error).toBe("Open a conversation first.");
  });

  it("lets the owner untick and apply triage suggestions once", async () => {
    const { ctx, ai, gmail, store } = await setup();
    store.toggleSelect(k("t1"));
    store.toggleSelect(k("t2"));
    ai.fallback = JSON.stringify([{ thread: 1, action: "archive", reason: "done" }, { thread: 2, action: "flag", reason: "needs you" }]);
    const agent = createMailAgent(ctx);
    await agent.suggestTriage();
    const item = agent.getState().items[0];
    if (item.kind !== "triage") throw new Error("expected triage");
    agent.toggleTriage(item.id, item.suggestions[1].id, false);
    await agent.applyTriage(item.id);
    await agent.applyTriage(item.id);
    expect(gmail.calls.modifyThreads).toHaveLength(1);
    expect(agent.getState().items[0]).toMatchObject({ status: "applied", outcome: { applied: 1, failed: 0 } });
  });

  it("cancel stops a running task without an error banner for the cancellation", async () => {
    const { ctx, ai, store } = await setup();
    await store.openThread(k("t1"));
    let release!: () => void;
    ai.fallback = () => new Promise<string>((resolve) => {
      release = () => resolve('{"body":"late"}');
    });
    const agent = createMailAgent(ctx);
    const running = agent.draftReply("x");
    await new Promise((resolve) => setTimeout(resolve, 0));
    agent.cancel();
    release();
    await running;
    expect(agent.getState().error).toBe("Stopped.");
    expect(Object.keys(store.getSnapshot().drafts)).toHaveLength(0);
  });

  it("creates a bulk session with the overall voice", async () => {
    const { ctx } = await setup();
    const bulk = await createMailAgent(ctx).createBulk();
    expect(bulk.getState().phase).toBe("idle");
  });
});

describe("no path sends without explicit confirmation", () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? sources(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
    });
  }

  it("calls sendDraft only from BulkDrafts.confirmSend, and never the store's send", () => {
    const root = path.resolve(__dirname, "../../../../home/apps/mail/src");
    const files = [...sources(path.join(root, "agent")), ...sources(path.join(root, "ui/agent"))];
    expect(files.length).toBeGreaterThan(10);
    const callers = files.filter((file) => /\.sendDraft\s*\(/.test(readFileSync(file, "utf8")));
    expect(callers.map((file) => path.basename(file))).toEqual(["bulk.ts"]);
    const bulk = readFileSync(path.join(root, "agent/bulk.ts"), "utf8");
    const confirmAt = bulk.indexOf("async confirmSend(");
    const sendAt = bulk.search(/\.sendDraft\s*\(/);
    expect(confirmAt).toBeGreaterThan(-1);
    expect(sendAt).toBeGreaterThan(confirmAt);
    expect(bulk.slice(confirmAt, sendAt)).toContain('throw new MailAgentError("not_confirmed")');
    for (const file of files) expect(readFileSync(file, "utf8")).not.toMatch(/store\.sendDraft|\.sendDraft\(\s*localId/);
  });
});

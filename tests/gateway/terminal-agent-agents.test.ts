import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalAgents } from "../../packages/gateway/src/terminal-agent/agents.js";
import { createTerminalAgentRegistry } from "../../packages/gateway/src/terminal-agent/registry.js";
import { createTerminalTemplates } from "../../packages/gateway/src/terminal-agent/templates.js";

const workspaceId = "tws_0123456789abcdef0123456789abcdef";
const parentId = "tt_0123456789abcdef0123456789abcdef";
const session = `matrix-w-${"e".repeat(32)}`;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Status = "idle" | "working" | "done" | "blocked" | "error";

async function harness(options: {
  statusAfterStart?: Status[];
  template?: string;
  admitWorkspace?: <T>(workspaceId: string, operation: () => Promise<T>) => Promise<T>;
} = {}) {
  const home = await mkdtemp(join(tmpdir(), "matrix-terminal-agents-"));
  roots.push(home);
  if (options.template) {
    await mkdir(join(home, "agents", "templates"), { recursive: true });
    await writeFile(join(home, "agents", "templates", "reviewer.md"), options.template);
  }
  let now = 0;
  let counter = 0;
  const tabs = new Map<string, Record<string, unknown>>([[parentId, {
    id: parentId, workspaceId, name: "lead", cwd: "", status: "running", revision: 1, order: 0,
    accessScope: "owner", createdAt: "2026-11-11T10:00:00.000Z", updatedAt: "2026-11-11T10:00:00.000Z",
  }]]);
  const statuses = new Map<string, Status>();
  const statusScript = [...(options.statusAfterStart ?? [])];
  const createdCommands: Array<string[] | undefined> = [];
  const sends: Array<{ tabId: string; text: string }> = [];
  const terminated: string[] = [];
  // Pane id -> tab, as the runtime resolves a caller's pane.
  const panes = new Map<string, string>([["3", parentId]]);
  const runtime = {
    listWorkspaces: async () => [{
      id: workspaceId, scope: "main", canonicalSize: { cols: 80, rows: 24 }, status: "running", revision: 1,
      createdAt: "2026-11-11T10:00:00.000Z", updatedAt: "2026-11-11T10:00:00.000Z", tabs: [...tabs.values()],
    }] as never,
    ensureWorkspace: async () => ({ id: workspaceId }) as never,
    createTab: async (_workspace: string, input: { name: string; command?: string[] }) => {
      counter += 1;
      const id = `tt_${String(counter).repeat(32).slice(0, 32)}`;
      createdCommands.push(input.command);
      const tab = {
        id, workspaceId, name: input.name, cwd: "", status: "running", revision: 1, order: counter,
        accessScope: "owner", createdAt: "2026-11-11T10:00:00.000Z", updatedAt: "2026-11-11T10:00:00.000Z",
        incarnation: `ti_${"a".repeat(32)}`,
      };
      tabs.set(id, tab);
      return tab as never;
    },
    terminateTab: async (ref: { tabId: string }) => {
      terminated.push(ref.tabId);
      tabs.set(ref.tabId, { ...tabs.get(ref.tabId), status: "exited", exitCode: 0 });
    },
    getSnapshot: async () => ({ viewport: ["> ready"] }),
    resolvePane: async (input: { sessionName: string; paneId: string }) => {
      const tabId = input.sessionName === session ? panes.get(input.paneId) : undefined;
      return tabId ? { workspaceId, tabId } : null;
    },
  };
  const statusSource = {
    list: async () => new Map([...statuses].map(([tabId, status]) => [`${workspaceId}:${tabId}`, {
      ref: { workspaceId, tabId }, status, reportedAt: "2026-11-11T10:00:00.000Z", source: "reporter" as const,
    }])),
    get: async (ref: { tabId: string }) => {
      if (ref.tabId !== parentId && statusScript.length > 0) statuses.set(ref.tabId, statusScript.shift()!);
      const status = statuses.get(ref.tabId);
      return status ? { ref: { workspaceId, tabId: ref.tabId }, status, reportedAt: "2026-11-11T10:00:00.000Z", source: "reporter" as const } : undefined;
    },
  };
  const verbs = {
    send: vi.fn(async (ref: { tabId: string }, input: { text: string; maxHoldMs?: number; deferWhileTyping?: boolean; signal?: AbortSignal }) => {
      sends.push({ tabId: ref.tabId, text: input.text });
      return { sent: true as const, heldMs: 0 };
    }),
  };
  const registry = createTerminalAgentRegistry({ homePath: home, now: () => new Date(now) });
  const agents = createTerminalAgents({
    runtime,
    verbs: verbs as never,
    status: statusSource,
    registry,
    templates: createTerminalTemplates({ homePath: home }),
    ...(options.admitWorkspace ? { admitWorkspace: options.admitWorkspace } : {}),
    now: () => now,
    sleep: async (ms) => { now += ms; },
  });
  return { home, agents, registry, tabs, statuses, createdCommands, sends, terminated, verbs, panes, advance: (ms: number) => { now += ms; }, time: () => now };
}

const reviewer = `---
name: reviewer
description: Reviews a change read-only
command: claude --model opus
---
Review only what you are asked. Read-only.
`;

// Fault detected: a delegated agent starts without its task, gets the task while
// still booting (dropped), or cannot tell who to report to.
describe("terminal agents: run", () => {
  it("starts a template's command and sends its body plus the task, addressed from the parent", async () => {
    const h = await harness({ template: reviewer, statusAfterStart: ["working", "idle"] });
    const result = await h.agents.run({
      name: "review", cwd: "projects/app", template: "reviewer", task: "Review src/x.ts",
      caller: { sessionName: session, paneId: "3" },
    });

    expect(h.createdCommands).toEqual([["sh", "-lc", "claude --model opus"]]);
    expect(result.parent).toEqual({ workspaceId, tabId: parentId });
    expect(result.firstMessage).toEqual({ sent: true });
    expect(h.sends).toEqual([{
      tabId: result.ref.tabId,
      text: `<matrix from="${parentId} lead" reach="matrix shell report when done or stuck">Review only what you are asked. Read-only.\n\nReview src/x.ts</matrix>`,
    }]);
    await expect(h.registry.get(result.ref)).resolves.toMatchObject({
      parent: { workspaceId, tabId: parentId }, template: "reviewer", firstMessage: { sent: true },
    });
  });

  it("does not send into a trust dialog and records why the task was not sent", async () => {
    const h = await harness({ template: reviewer, statusAfterStart: ["blocked"] });
    const result = await h.agents.run({ name: "review", cwd: "", template: "reviewer", task: "go" });
    expect(result.firstMessage).toEqual({ sent: false, reason: "blocked" });
    expect(h.sends).toEqual([]);
    await expect(h.registry.get(result.ref)).resolves.toMatchObject({ firstMessage: { sent: false, reason: "blocked" } });
  });

  it("sends a plain program's task once its screen settles", async () => {
    const h = await harness();
    const result = await h.agents.run({ name: "fix", cwd: "", argv: ["pi"], task: "fix it", noParent: true, caller: { sessionName: session, paneId: "3" } });
    expect(result.parent).toBeUndefined();
    expect(result.firstMessage).toEqual({ sent: true });
    expect(h.sends[0]?.text).toBe("fix it");
  });

  it("rejects unknown templates and an argv combined with a template", async () => {
    const h = await harness({ template: reviewer });
    await expect(h.agents.run({ name: "x", cwd: "", template: "nope" })).rejects.toMatchObject({ code: "not_found" });
    await expect(h.agents.run({ name: "x", cwd: "", template: "reviewer", argv: ["sh"] })).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("terminal agents: labels, reports and children", () => {
  it("sets and removes labels and persists them in the owner's home", async () => {
    const h = await harness();
    const ref = { workspaceId, tabId: parentId };
    await h.agents.label(ref, { set: { role: "lead", "herdr.pinned": "1" } });
    await expect(h.agents.label(ref, { remove: ["role"] })).resolves.toMatchObject({ labels: { "herdr.pinned": "1" } });
    expect(JSON.parse(await readFile(join(h.home, "system", "terminal-agents.json"), "utf8"))).toMatchObject({ version: 1 });
    await expect(h.agents.label(ref, { set: { "Bad Key": "x" } })).rejects.toThrow();
  });

  it("delivers a child's report to its parent, tagged with the child", async () => {
    const h = await harness();
    const child = await h.agents.run({ name: "review", cwd: "", argv: ["sh"], parent: { workspaceId, tabId: parentId } });
    // The child reports from its own pane, which the runtime resolves to the child's tab.
    const childPane = { sessionName: session, paneId: "9" };
    await expect(createTerminalAgentsWithResolver(h, async () => child.ref).reportToParent({ caller: childPane, text: "2 bugs; see /tmp/f.md" }))
      .resolves.toEqual({ sent: true, parent: { workspaceId, tabId: parentId } });
    expect(h.sends.at(-1)).toEqual({ tabId: parentId, text: `<matrix from="${child.ref.tabId} review">2 bugs; see /tmp/f.md</matrix>` });
  });

  it("waits for any child's news and for all children to stop", async () => {
    const h = await harness();
    const child = await h.agents.run({ name: "review", cwd: "", argv: ["sh"], parent: { workspaceId, tabId: parentId } });
    h.statuses.set(child.ref.tabId, "working");
    const parent = { workspaceId, tabId: parentId };
    await expect(h.agents.waitChildren(parent, { mode: "all", timeoutMs: 2_000 })).resolves.toMatchObject({ reason: "timeout" });
    h.statuses.set(child.ref.tabId, "done");
    await expect(h.agents.waitChildren(parent, { mode: "all", timeoutMs: 2_000 })).resolves.toEqual({ reason: "idle" });
    await expect(h.agents.waitChildren({ workspaceId, tabId: child.ref.tabId }, { mode: "any", timeoutMs: 1_000 }))
      .resolves.toEqual({ reason: "none" });
  });
});

describe("terminal agents: supervision", () => {
  // Fault detected: helpers keep running (and spending) after the agent that started them ends,
  // or a blocked helper waits forever because nobody tells its parent.
  it("notes a blocked child to its parent once and ends children whose parent ended", async () => {
    const h = await harness();
    const parent = { workspaceId, tabId: parentId };
    const keeper = await h.agents.run({ name: "server", cwd: "", argv: ["sh"], parent, outliveParent: true });
    const helper = await h.agents.run({ name: "review", cwd: "", argv: ["sh"], parent });
    const state = new Map<string, string>();

    h.statuses.set(helper.ref.tabId, "blocked");
    await h.agents.supervise(state);
    await h.agents.supervise(state);
    expect(h.sends.filter((send) => send.tabId === parentId)).toEqual([{
      tabId: parentId,
      text: `<matrix from="${helper.ref.tabId} review">is blocked and needs a person; read its screen</matrix>`,
    }]);

    h.tabs.set(parentId, { ...h.tabs.get(parentId), status: "exited", exitCode: 0 });
    await h.agents.supervise(state);
    expect(h.terminated).toEqual([helper.ref.tabId]);
    expect(h.terminated).not.toContain(keeper.ref.tabId);
  });
});

function createTerminalAgentsWithResolver(
  h: Awaited<ReturnType<typeof harness>>,
  resolve: () => Promise<{ workspaceId: string; tabId: string }>,
) {
  return createTerminalAgents({
    runtime: {
      listWorkspaces: async () => [{
        id: workspaceId, scope: "main", canonicalSize: { cols: 80, rows: 24 }, status: "running", revision: 1,
        createdAt: "2026-11-11T10:00:00.000Z", updatedAt: "2026-11-11T10:00:00.000Z", tabs: [...h.tabs.values()],
      }] as never,
      ensureWorkspace: async () => ({ id: workspaceId }) as never,
      createTab: async () => { throw new Error("unused"); },
      terminateTab: async () => undefined,
      getSnapshot: async () => ({ viewport: [] }),
      resolvePane: resolve,
    },
    verbs: h.verbs as never,
    status: { list: async () => new Map(), get: async () => undefined },
    registry: h.registry,
    templates: createTerminalTemplates({ homePath: h.home }),
  });
}

// Fault detected (review of #3298): truncated tasks, oversized reports, children whose
// record vanished, records pruned mid-run, and writes that bypass project fences.
describe("terminal agents: limits, vanished children and admission", () => {
  it("refuses a task that would not fit one send before starting anything", async () => {
    const h = await harness({ template: reviewer });
    await expect(h.agents.run({ name: "review", cwd: "", template: "reviewer", task: "x".repeat(8_200) }))
      .rejects.toMatchObject({ code: "invalid_request" });
    expect(h.createdCommands).toEqual([]);
  });

  it("refuses a report too long to fit with its envelope", async () => {
    const h = await harness();
    await expect(createTerminalAgentsWithResolver(h, async () => ({ workspaceId, tabId: parentId }))
      .reportToParent({ caller: { sessionName: session, paneId: "9" }, text: "x".repeat(8_000) }))
      .rejects.toMatchObject({ code: "invalid_request" });
  });

  it("reports a child whose record disappeared as exited", async () => {
    const h = await harness();
    const parent = { workspaceId, tabId: parentId };
    const child = await h.agents.run({ name: "review", cwd: "", argv: ["sh"], parent });
    h.statuses.set(child.ref.tabId, "working");
    const waiting = h.agents.waitChildren(parent, { mode: "any", timeoutMs: 5_000 });
    await h.registry.prune(new Set());
    await expect(waiting).resolves.toEqual({ reason: "changed", child: child.ref, exited: true });
  });

  it("notes a removed child once, keeps a young record, and keeps the record while the note is owed", async () => {
    const admitted: string[] = [];
    const h = await harness({ admitWorkspace: async (workspace, operation) => { admitted.push(workspace); return operation(); } });
    const parent = { workspaceId, tabId: parentId };
    const child = await h.agents.run({ name: "review", cwd: "", argv: ["sh"], parent });
    const state = new Map<string, string>();

    h.tabs.delete(child.ref.tabId);
    h.verbs.send.mockRejectedValueOnce(new (await import("../../packages/gateway/src/terminal-agent/verbs.js")).TerminalAgentVerbError("blocked"));
    await h.agents.supervise(state);
    // Refused while the parent was blocked: the record stays so the note can be retried.
    h.advance(120_000);
    await h.agents.supervise(state);
    expect(h.sends.filter((send) => send.tabId === parentId).map((send) => send.text)).toEqual([
      `<matrix from="${child.ref.tabId} ${child.ref.tabId}">exited</matrix>`,
    ]);
    expect(admitted.length).toBeGreaterThanOrEqual(2);
    await h.agents.supervise(state);
    await expect(h.registry.get(child.ref)).resolves.toBeUndefined();
    expect(h.sends.filter((send) => send.tabId === parentId)).toHaveLength(1);
  });

  it("keeps the record of a tab created during a supervision pass", async () => {
    const h = await harness();
    const parent = { workspaceId, tabId: parentId };
    const child = await h.agents.run({ name: "review", cwd: "", argv: ["sh"], parent });
    // The tab is not listed yet, but its record is brand new.
    h.tabs.delete(child.ref.tabId);
    h.verbs.send.mockRejectedValueOnce(new Error("socket"));
    await h.agents.supervise(new Map());
    await expect(h.registry.get(child.ref)).resolves.toBeDefined();
  });
});

// Fault detected (second review of #3298): wait-children returned on the status a
// helper reported before it received its task.
describe("terminal agents: children after a send", () => {
  it("does not count a pre-send report as the child having stopped", async () => {
    const h = await harness();
    const parent = { workspaceId, tabId: parentId };
    const child = await h.agents.run({ name: "review", cwd: "", argv: ["sh"], parent });
    h.statuses.set(child.ref.tabId, "idle");
    const agents = createTerminalAgents({
      runtime: {
        listWorkspaces: async () => [{
          id: workspaceId, scope: "main", canonicalSize: { cols: 80, rows: 24 }, status: "running", revision: 1,
          createdAt: "2026-11-11T10:00:00.000Z", updatedAt: "2026-11-11T10:00:00.000Z", tabs: [...h.tabs.values()],
        }] as never,
        ensureWorkspace: async () => ({ id: workspaceId }) as never,
        createTab: async () => { throw new Error("unused"); },
        terminateTab: async () => undefined,
        getSnapshot: async () => ({ viewport: [] }),
      },
      verbs: h.verbs as never,
      status: {
        list: async () => new Map([[`${workspaceId}:${child.ref.tabId}`, {
          ref: child.ref, status: "idle" as const, reportedAt: new Date(0).toISOString(), source: "hook" as const,
        }]]),
        get: async () => undefined,
        sentAt: () => 1_000,
      },
      registry: h.registry,
      templates: createTerminalTemplates({ homePath: h.home }),
      now: () => 2_000,
      sleep: async () => undefined,
    });
    await expect(agents.waitChildren(parent, { mode: "all", timeoutMs: 0 })).resolves.toMatchObject({ reason: "timeout" });
  });
});

// Fault detected (third review of #3298): a launch outlived its caller's request, and
// repeated child waits multiplied runtime polling without a bound.
describe("terminal agents: launch deadline and wait limits", () => {
  // Fault detected (fourth review of #3298): the first message's draft hold could run
  // past the launch deadline the caller asked for.
  it("bounds the first message's draft hold by what is left of the launch deadline", async () => {
    const h = await harness({ template: reviewer, statusAfterStart: ["idle"] });
    await h.agents.run({ name: "review", cwd: "", template: "reviewer", task: "go", readyTimeoutMs: 25_000 });
    const [, input] = h.verbs.send.mock.calls[0] as unknown as [unknown, { maxHoldMs?: number }];
    expect(input.maxHoldMs).toBeGreaterThan(0);
    expect(input.maxHoldMs).toBeLessThanOrEqual(25_000);
  });

  it("gives up on readiness at the caller's deadline and says so", async () => {
    const h = await harness({ template: reviewer, statusAfterStart: Array(200).fill("working") });
    const started = h.time();
    const result = await h.agents.run({ name: "review", cwd: "", template: "reviewer", task: "go", readyTimeoutMs: 5_000 });
    expect(result.firstMessage).toEqual({ sent: false, reason: "not_ready" });
    expect(h.time() - started).toBeLessThanOrEqual(5_500);
    expect(h.sends).toEqual([]);
  });

  it("caps concurrent child waits per parent and releases each slot when it ends", async () => {
    const h = await harness();
    const parent = { workspaceId, tabId: parentId };
    const child = await h.agents.run({ name: "review", cwd: "", argv: ["sh"], parent });
    h.statuses.set(child.ref.tabId, "working");
    const waits = Array.from({ length: 4 }, () => h.agents.waitChildren(parent, { mode: "all", timeoutMs: 2_000 }));
    await expect(h.agents.waitChildren(parent, { mode: "all", timeoutMs: 2_000 })).rejects.toMatchObject({ code: "capacity" });
    await Promise.all(waits);
    await expect(h.agents.waitChildren(parent, { mode: "all", timeoutMs: 0 })).resolves.toMatchObject({ reason: "timeout" });
  });
});

// Fault detected (fifth review of #3298): a full registry silently evicted a live
// helper's record, and a child's news between two check-ins was lost.
describe("terminal agents: registry capacity and child baselines", () => {
  it("refuses a new record when the registry is full instead of evicting a live one", async () => {
    const h = await harness();
    const tooMany = Array.from({ length: 10_240 }, (_, i) => ({
      ref: { workspaceId, tabId: `tt_${i.toString(16).padStart(32, "0")}` }, labels: {}, outliveParent: false, createdAt: "2026-11-12T00:00:00.000Z",
    }));
    await mkdir(join(h.home, "system"), { recursive: true });
    await writeFile(join(h.home, "system", "terminal-agents.json"), JSON.stringify({ version: 1, agents: tooMany }));
    await expect(h.registry.upsert({ workspaceId, tabId: parentId }, (record) => record)).rejects.toMatchObject({ code: "capacity" });
    await expect(h.registry.get(tooMany[0]!.ref)).resolves.toBeDefined();
  });

  it("carries the starting child states from one check-in to the next", async () => {
    const h = await harness();
    const parent = { workspaceId, tabId: parentId };
    const child = await h.agents.run({ name: "review", cwd: "", argv: ["sh"], parent });
    h.statuses.set(child.ref.tabId, "working");
    const first = await h.agents.waitChildren(parent, { mode: "any", timeoutMs: 0 });
    expect(first).toMatchObject({ reason: "timeout", cursor: expect.stringMatching(/^wc_[0-9a-f]{32}$/) });
    // The child finishes between the two requests.
    h.statuses.set(child.ref.tabId, "done");
    const cursor = first.reason === "timeout" ? first.cursor : undefined;
    await expect(h.agents.waitChildren(parent, { mode: "any", timeoutMs: 0, ...(cursor ? { cursor } : {}) }))
      .resolves.toEqual({ reason: "changed", child: child.ref, status: "done" });
    // A cursor only describes its own parent's children.
    await expect(h.agents.waitChildren({ workspaceId, tabId: child.ref.tabId }, { mode: "any", timeoutMs: 0, ...(cursor ? { cursor } : {}) }))
      .resolves.toEqual({ reason: "none" });
  });
});

// Fault detected (seventh review of #3298): a launch whose agent record could not be
// saved left the helper running with no parent or cleanup.
describe("terminal agents: failed registration", () => {
  it("ends the new tab and reports the failure when its record cannot be saved", async () => {
    const h = await harness();
    vi.spyOn(h.registry, "upsert").mockRejectedValueOnce(new Error("disk full"));
    await expect(h.agents.run({ name: "review", cwd: "", argv: ["sh"], parent: { workspaceId, tabId: parentId } }))
      .rejects.toThrow("disk full");
    expect(h.terminated).toHaveLength(1);
    expect(h.createdCommands).toHaveLength(1);
  });
});

// Fault detected (review of #3298): a child's report never woke its parent's
// `wait-children any`, notes held supervision for a minute while a person typed, and
// child waits kept running after the services closed.
describe("terminal agents: reports, notes and shutdown", () => {
  it("wakes a parent waiting on any child when that child reports", async () => {
    const h = await harness();
    const parent = { workspaceId, tabId: parentId };
    const child = await h.agents.run({ name: "review", cwd: "", argv: ["sh"], parent });
    h.statuses.set(child.ref.tabId, "working");
    h.panes.set("9", child.ref.tabId);
    const first = await h.agents.waitChildren(parent, { mode: "any", timeoutMs: 0 });
    expect(first).toMatchObject({ reason: "timeout" });

    await h.agents.reportToParent({ caller: { sessionName: session, paneId: "9" }, text: "done; see notes" });

    const cursor = first.reason === "timeout" ? first.cursor : undefined;
    await expect(h.agents.waitChildren(parent, { mode: "any", timeoutMs: 1_000, ...(cursor ? { cursor } : {}) }))
      .resolves.toEqual({ reason: "changed", child: child.ref, reported: true });
  });

  it("gives a parent note a short, deferrable hold", async () => {
    const h = await harness();
    const parent = { workspaceId, tabId: parentId };
    const helper = await h.agents.run({ name: "review", cwd: "", argv: ["sh"], parent });
    h.statuses.set(helper.ref.tabId, "blocked");
    await h.agents.supervise(new Map());
    const noteCall = h.verbs.send.mock.calls.find(([ref]) => ref.tabId === parentId);
    expect(noteCall?.[1]).toMatchObject({ deferWhileTyping: true, signal: expect.any(AbortSignal) });
    expect(noteCall?.[1].maxHoldMs).toBeLessThanOrEqual(2_000);
  });

  it("ends child waits on close and waits for them to finish", async () => {
    const h = await harness();
    const parent = { workspaceId, tabId: parentId };
    const child = await h.agents.run({ name: "review", cwd: "", argv: ["sh"], parent });
    h.statuses.set(child.ref.tabId, "working");
    let settled = false;
    const wait = h.agents.waitChildren(parent, { mode: "all", timeoutMs: 3_600_000 }).finally(() => { settled = true; });
    await h.agents.close();
    expect(settled).toBe(true);
    await expect(wait).resolves.toMatchObject({ reason: "timeout" });
  });
});

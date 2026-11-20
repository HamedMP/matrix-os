import { describe, expect, it } from "vitest";
import {
  activeMentionQuery, availableTaskActions, buildChannelTree, channelInScope,
  formatLeaseCountdown, groupTasksByState, insertMention, matchesLabelFilter, parseLabelFilter,
  parseLabelInput, sortThreadsByActivity, validateChannelPath,
} from "../../packages/ui/src/message-board/model";
import type { BoardActor, BoardChannel, BoardTask, BoardThreadSummary } from "../../packages/ui/src/message-board/types";

const me: BoardActor = { id: "user:me", kind: "user", name: "You" };
const fixer: BoardActor = { id: "agent:chat_1", kind: "agent", name: "chat_1", profile: "fixer" };

function channel(path: string, unread = 0): BoardChannel {
  return { path, unread, threadCount: 1, lastActivityAt: null };
}

function task(overrides: Partial<BoardTask> = {}): BoardTask {
  return { state: "ready", createdBy: me.id, assignedProfile: null, holder: null, leaseUntil: null, epoch: 0, needs: [], updatedAt: "2026-11-19T10:00:00.000Z", ...overrides };
}

function summary(id: string, overrides: Partial<BoardThreadSummary> & { labels?: Record<string, string>; text?: string; by?: BoardActor; channel?: string } = {}): BoardThreadSummary {
  const { labels = {}, text = `Thread ${id}`, by = me, channel: path = "dev", ...rest } = overrides;
  return {
    root: { id, channel: path, text, re: null, replyTo: null, by, labels, reactions: [], revision: 1, createdAt: "2026-11-19T09:00:00.000Z" },
    replyCount: 0, latestReply: null, lastActivityAt: "2026-11-19T09:00:00.000Z", task: null, unread: false, ...rest,
  };
}

describe("channel tree", () => {
  it("groups channels by prefix, sorts each level, and sums unread counts into groups", () => {
    const tree = buildChannelTree([channel("security/triage", 2), channel("dev", 3), channel("security/findings", 1), channel("incidents")]);
    expect(tree.map((node) => node.path)).toEqual(["dev", "incidents", "security"]);
    const security = tree[2]!;
    expect(security.channel).toBeNull();
    expect(security.unread).toBe(3);
    expect(security.children.map((node) => [node.segment, node.path, node.depth])).toEqual([
      ["findings", "security/findings", 1], ["triage", "security/triage", 1],
    ]);
  });

  it("keeps a channel that is also a prefix as both a channel and a group", () => {
    const [projects] = buildChannelTree([channel("projects", 1), channel("projects/matrix-os", 2)]);
    expect(projects!.channel?.path).toBe("projects");
    expect(projects!.unread).toBe(3);
    expect(projects!.children[0]!.path).toBe("projects/matrix-os");
  });

  it("matches exact channels, subtrees with a trailing slash, and every channel for *", () => {
    expect(channelInScope("dev", "dev")).toBe(true);
    expect(channelInScope("dev", "dev/ops")).toBe(false);
    expect(channelInScope("security/", "security/findings")).toBe(true);
    expect(channelInScope("security/", "security")).toBe(true);
    expect(channelInScope("security/", "securityteam")).toBe(false);
    expect(channelInScope("*", "projects/matrix-os")).toBe(true);
  });

  it("accepts only lowercase segment paths within the spec limits", () => {
    expect(validateChannelPath("security/findings")).toBe(true);
    expect(validateChannelPath("projects/matrix-os")).toBe(true);
    for (const bad of ["", "Dev", "dev/", "/dev", "dev//ops", "a b", "x".repeat(49), Array(9).fill("a").join("/")]) {
      expect(validateChannelPath(bad), bad).toBe(false);
    }
  });
});

describe("label filters", () => {
  it("parses key, key=value and key=value|value forms", () => {
    expect(parseLabelFilter("kind")).toEqual({ key: "kind", values: null });
    expect(parseLabelFilter("kind=bug")).toEqual({ key: "kind", values: ["bug"] });
    expect(parseLabelFilter(" kind=bug|flake ")).toEqual({ key: "kind", values: ["bug", "flake"] });
    expect(parseLabelFilter("")).toBeNull();
    expect(parseLabelFilter("=bug")).toBeNull();
    expect(parseLabelFilter("Kind=bug")).toBeNull();
  });

  it("matches the message or its thread root", () => {
    const filter = parseLabelFilter("kind=bug|flake")!;
    expect(matchesLabelFilter(filter, { kind: "bug" })).toBe(true);
    expect(matchesLabelFilter(filter, { kind: "docs" })).toBe(false);
    expect(matchesLabelFilter(filter, {}, { kind: "flake" })).toBe(true);
    expect(matchesLabelFilter(parseLabelFilter("pr")!, { pr: "#3501" })).toBe(true);
    expect(matchesLabelFilter(parseLabelFilter("pr")!, { kind: "bug" })).toBe(false);
  });

  it("parses a label typed by a person and refuses reserved or malformed keys", () => {
    expect(parseLabelInput("pr=#3501")).toEqual({ ok: true, key: "pr", value: "#3501" });
    expect(parseLabelInput("board.task=ready")).toEqual({ ok: false, reason: "reserved" });
    expect(parseLabelInput("matrix.watcher=x")).toEqual({ ok: false, reason: "reserved" });
    expect(parseLabelInput("kind")).toEqual({ ok: false, reason: "format" });
    expect(parseLabelInput("Kind=bug")).toEqual({ ok: false, reason: "format" });
    expect(parseLabelInput(`kind=${"x".repeat(257)}`)).toEqual({ ok: false, reason: "format" });
  });
});

describe("thread list", () => {
  it("sorts newest activity first with a stable tie-break on ID", () => {
    const sorted = sortThreadsByActivity([
      summary("a", { lastActivityAt: "2026-11-19T09:00:00.000Z" }),
      summary("c", { lastActivityAt: "2026-11-19T11:00:00.000Z" }),
      summary("b", { lastActivityAt: "2026-11-19T11:00:00.000Z" }),
    ]);
    expect(sorted.map((thread) => thread.root.id)).toEqual(["c", "b", "a"]);
  });

  it("groups board tasks into queue order and leaves plain threads out", () => {
    const groups = groupTasksByState([
      summary("done", { task: task({ state: "completed" }) }),
      summary("plain"),
      summary("r1", { task: task({ state: "ready" }), lastActivityAt: "2026-11-19T08:00:00.000Z" }),
      summary("r2", { task: task({ state: "ready" }), lastActivityAt: "2026-11-19T12:00:00.000Z" }),
      summary("held", { task: task({ state: "blocked" }) }),
    ]);
    expect(groups.map((group) => [group.state, group.threads.map((t) => t.root.id)])).toEqual([
      ["ready", ["r2", "r1"]], ["blocked", ["held"]], ["completed", ["done"]],
    ]);
  });
});

describe("lease countdown", () => {
  const now = Date.parse("2026-11-19T10:00:00.000Z");
  it("formats minutes and seconds, hours when needed, and expiry", () => {
    expect(formatLeaseCountdown("2026-11-19T10:03:12.000Z", now)).toBe("3:12");
    expect(formatLeaseCountdown("2026-11-19T10:00:05.400Z", now)).toBe("0:06");
    expect(formatLeaseCountdown("2026-11-19T11:00:00.000Z", now)).toBe("1:00:00");
    expect(formatLeaseCountdown("2026-11-19T09:59:59.000Z", now)).toBe("expired");
    expect(formatLeaseCountdown(null, now)).toBeNull();
    expect(formatLeaseCountdown("not a date", now)).toBeNull();
  });
});

describe("mentions", () => {
  it("finds the mention being typed at the caret", () => {
    expect(activeMentionQuery("hey @rev", 8)).toEqual({ start: 4, query: "rev" });
    expect(activeMentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(activeMentionQuery("mail me@host", 12)).toBeNull();
    expect(activeMentionQuery("hey @rev done", 13)).toBeNull();
  });

  it("replaces the typed mention and places the caret after it", () => {
    expect(insertMention("hey @rev please", { start: 4, query: "rev" }, "reviewer")).toEqual({ text: "hey @reviewer please", caret: 14 });
    expect(insertMention("ping @fi", { start: 5, query: "fi" }, "fixer")).toEqual({ text: "ping @fixer ", caret: 12 });
  });
});

describe("person task actions", () => {
  it("offers each state the actions a person may take", () => {
    expect(availableTaskActions(task({ state: "ready" }), me.id)).toEqual(["claim", "assign", "block", "cancel"]);
    expect(availableTaskActions(task({ state: "waiting" }), me.id)).toEqual(["assign", "cancel"]);
    expect(availableTaskActions(task({ state: "claimed", holder: fixer }), me.id)).toEqual(["cancel"]);
    expect(availableTaskActions(task({ state: "claimed", holder: me }), me.id)).toEqual(["complete", "release", "block", "cancel"]);
    expect(availableTaskActions(task({ state: "blocked" }), me.id)).toEqual(["unblock", "cancel"]);
    expect(availableTaskActions(task({ state: "failed" }), me.id)).toEqual(["reopen"]);
    expect(availableTaskActions(task({ state: "completed" }), me.id)).toEqual(["reopen"]);
    expect(availableTaskActions(task({ state: "canceled" }), me.id)).toEqual(["reopen"]);
  });
});

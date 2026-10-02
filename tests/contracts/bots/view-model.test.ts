import { describe, expect, it } from "vitest";
import type { BotAuthorityView, BotInteraction, BotTaskSummary } from "@matrix-os/contracts";
import { botInteractionCard, botTaskStatusCopy, groupBotAuthority, botServiceLabel, botConnectionStateLabel, botAccessLabel } from "@matrix-os/contracts";

const now = "2026-09-28T12:00:00.000Z";
const interaction = (overrides: Partial<BotInteraction> = {}): BotInteraction => ({
  interactionId: "in_abcdefgh", chatId: "chat_research", agentId: "bot_research1",
  taskId: "task_abcdefgh", kind: "question", blocking: true, status: "pending",
  expiresAt: "2026-09-28T13:00:00.000Z", revision: 1,
  payload: { kind: "question", questions: [{ questionId: "target", header: "Target", question: "Which company?" }] },
  ...overrides,
});

describe("bot interaction view model", () => {
  it("shows an actionable question only to the responder while it is pending", () => {
    expect(botInteractionCard(interaction(), now)).toMatchObject({ state: "actionable", title: "Question", actionLabel: "Answer" });
    expect(botInteractionCard(interaction({ payload: undefined }), now)).toMatchObject({ state: "unavailable", actionLabel: null });
  });

  it("never offers an action after expiry or resolution, including stale pending records", () => {
    expect(botInteractionCard(interaction({ expiresAt: now }), now)).toMatchObject({ state: "expired", actionLabel: null });
    expect(botInteractionCard(interaction({ status: "resolved" }), now)).toMatchObject({ state: "resolved", actionLabel: null });
  });

  it("uses fixed action labels for account choice, connection and approval", () => {
    expect(botInteractionCard(interaction({ kind: "account_choice", payload: undefined }), now).title).toBe("Choose an account");
    expect(botInteractionCard(interaction({ kind: "connect_request", payload: undefined }), now).title).toBe("Connect a service");
    expect(botInteractionCard(interaction({ kind: "approval", payload: undefined }), now).title).toBe("Approval requested");
  });
});

describe("bot authority view model", () => {
  it("groups grants under their service and includes connected services with no grants", () => {
    const view: BotAuthorityView = {
      agentId: "bot_research1", revision: 1,
      connections: [{ service: "gmail", state: "granted" }, { service: "google_calendar", state: "connected_not_granted" }],
      grants: [{ grantId: "grant_abcdefgh", service: "gmail", accountLabel: "Work", effects: ["read"], audience: "direct", expiresAt: null }],
      routines: [], pendingInteractions: [], memory: { items: [] },
    };
    expect(groupBotAuthority(view)).toEqual([
      { service: "gmail", state: "granted", grants: view.grants },
      { service: "google_calendar", state: "connected_not_granted", grants: [] },
    ]);
  });

  it("shows a live grant as granted when inventory omits its service", () => {
    const grant = { grantId: "grant_abcdefgh", service: "gmail" as const, accountLabel: "Work",
      effects: ["read" as const], audience: "direct" as const, expiresAt: null };
    const view: BotAuthorityView = { agentId: "bot_research1", revision: 1, connections: [],
      grants: [grant], routines: [], pendingInteractions: [], memory: { items: [] } };
    expect(groupBotAuthority(view)).toEqual([{ service: "gmail", state: "granted", grants: [grant] }]);
  });
});

describe("bot task status copy", () => {
  const task = (overrides: Partial<BotTaskSummary> = {}): BotTaskSummary => ({
    taskId: "task_abcdefgh", chatId: "chat_research", agentId: "bot_research1",
    status: "running", revision: 1, updatedAt: now, ...overrides,
  });
  it("distinguishes waiting for a person from waiting for capacity", () => {
    expect(botTaskStatusCopy(task({ status: "waiting_person" }))).toBe("Waiting for your answer");
    expect(botTaskStatusCopy(task({ status: "waiting_capacity" }))).toBe("Waiting for capacity");
  });
  it("maps blocked reasons to fixed user-facing text", () => {
    expect(botTaskStatusCopy(task({ status: "blocked", blockedReason: "grant_revoked" }))).toBe("Access was removed");
    expect(botTaskStatusCopy(task({ status: "blocked" }))).toBe("Needs attention");
  });
});

it("uses friendly service, connection, and permission labels across surfaces", () => {
  expect(botServiceLabel("gmail")).toBe("Gmail");
  expect(botServiceLabel("google_calendar")).toBe("Google Calendar");
  expect(botServiceLabel("custom_notes")).toBe("Custom Notes");
  expect(botConnectionStateLabel("granted")).toBe("Access allowed");
  expect(botConnectionStateLabel("connected_not_granted")).toBe("Connected · no access");
  expect(botConnectionStateLabel("not_connected")).toBe("Not connected");
  expect(botAccessLabel(["read", "send"])).toBe("Read, Send");
});

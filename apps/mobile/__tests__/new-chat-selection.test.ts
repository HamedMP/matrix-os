import type { CanonicalChatModelSelection, CanonicalChatRecord } from "@matrix-os/contracts";

import { newChatSelection } from "@/components/chat/new-chat-selection";

import {
  GLM,
  GPT,
  PLAN,
  REASONING,
  catalogOf,
  codexInstance,
  matrixInstance,
  planBinding,
  planInstance,
} from "./model-test-catalog";

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

// Matrix AI is the default; Codex and Claude are what someone may have used last.
const CLAUDE = { instanceId: "claude_default", model: "claude-opus-5" };
const high = [{ id: "effort", value: "high" }];

function catalog() {
  return catalogOf(
    matrixInstance([[GLM.model, "GLM Flash"]], { defaultSelection: GLM }),
    codexInstance([[GPT.model, "GPT-5.6-Sol"], ["gpt-5.6-mini", "GPT-5.6 Mini"]], { options: [REASONING] }),
    codexInstance([[CLAUDE.model, "Opus 5"]], { id: CLAUDE.instanceId, driverKind: "claude_code", displayName: "Claude", options: [REASONING] }),
  );
}

/** A chat of the project, last active `minutesAgo` minutes ago, started on `selection`. */
function chat(id: string, minutesAgo: number, selection?: CanonicalChatModelSelection): CanonicalChatRecord {
  const at = new Date(Date.UTC(2026, 10, 14, 12, 0) - minutesAgo * 60_000).toISOString();
  return {
    chat: {
      id,
      ownerScope: { type: "personal", ownerId: "user_a" },
      title: id,
      lifecycle: "active",
      attention: "none",
      revision: 1,
      messageCount: 1,
      ...(selection ? { currentSelection: selection } : {}),
      activityAt: at,
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: at,
    },
    projectId: "proj_portfolio",
  } as CanonicalChatRecord;
}

describe("the model a new chat starts on", () => {
  it("is the default when nothing was used before", () => {
    expect(newChatSelection(catalog(), {})).toEqual(GLM);
  });

  it("is nothing while there is no catalog to choose from", () => {
    expect(newChatSelection(null, { remembered: { ...GPT, options: high } })).toBeNull();
  });

  it("follows the project's most recently active chat, with the effort it was set to", () => {
    const chats = [
      chat("older", 60, { ...CLAUDE, options: [{ id: "effort", value: "low" }] }),
      chat("latest", 5, { ...GPT, options: high }),
    ];

    expect(newChatSelection(catalog(), { projectChats: chats, remembered: CLAUDE })).toEqual({ ...GPT, options: high });
  });

  it("looks past project chats that name no model, and archived ones", () => {
    const archived = chat("archived", 1, { ...CLAUDE, options: high });
    archived.chat.lifecycle = "archived";
    const chats = [chat("no-model", 2), archived, chat("used", 30, { ...GPT, options: high })];

    expect(newChatSelection(catalog(), { projectChats: chats })).toEqual({ ...GPT, options: high });
  });

  it("falls back to the choice made on this phone when the project's latest chat cannot run now", () => {
    const offline = catalogOf(...catalog().instances.map((instance) => (
      instance.id === GPT.instanceId ? { ...instance, availability: "unavailable" as const } : instance
    )));
    const chats = [chat("latest", 5, { ...GPT, options: high })];

    expect(newChatSelection(offline, { projectChats: chats, remembered: { ...CLAUDE, options: high } }))
      .toEqual({ ...CLAUDE, options: high });
  });

  it("uses the choice made on this phone in a project with no chats, keeping its effort", () => {
    expect(newChatSelection(catalog(), { projectChats: [], remembered: { ...CLAUDE, options: high } }))
      .toEqual({ ...CLAUDE, options: high });
  });

  it("falls back to the default when the remembered model is no longer listed", () => {
    expect(newChatSelection(catalog(), { remembered: { ...GPT, model: "gpt-4-retired", options: high } })).toEqual(GLM);
  });

  it("takes the engine's own effort when the remembered one is no longer offered", () => {
    expect(newChatSelection(catalog(), { remembered: { ...GPT, options: [{ id: "effort", value: "ultra" }] } }))
      .toEqual({ ...GPT, options: [{ id: "effort", value: "medium" }] });
  });

  it("never starts on a route only agents run on", () => {
    const agentsOnly = catalogOf(...catalog().instances.map((instance) => (
      instance.id === CLAUDE.instanceId ? { ...instance, supports: { ...instance.supports, rootChat: false } } : instance
    )));

    expect(newChatSelection(agentsOnly, { remembered: { ...CLAUDE, options: high } })).toEqual(GLM);
  });

  it("names the account an own-account route runs through now, not the one it ran through before", () => {
    const plan = catalogOf(...catalog().instances, planInstance(undefined, planBinding("acct_now", "3")));

    expect(newChatSelection(plan, { remembered: { ...PLAN, options: planBinding("acct_before", "1") } }))
      .toEqual({ ...PLAN, options: planBinding("acct_now", "3") });
  });
});

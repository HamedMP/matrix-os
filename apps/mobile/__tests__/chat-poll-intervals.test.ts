import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";

import { botChatRefetchInterval } from "../lib/queries/use-bot-chat";
import { activeRunPollInterval } from "../lib/queries/use-canonical-chat-detail";
import type { NativeBotChatSnapshot } from "../lib/requests/bots";

// The shared contracts barrel pulls in ESM-only micromark, which this Jest suite cannot load.
jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));
jest.mock("@clerk/clerk-expo", () => ({ useAuth: jest.fn() }));

function detailWithRuns(...statuses: string[]): CanonicalChatDetailResponse {
  return { runs: statuses.map((status) => ({ status })) } as unknown as CanonicalChatDetailResponse;
}

describe("activeRunPollInterval", () => {
  it("does not poll a chat with no run in progress", () => {
    expect(activeRunPollInterval(undefined, false)).toBe(false);
    expect(activeRunPollInterval(detailWithRuns(), false)).toBe(false);
    expect(activeRunPollInterval(detailWithRuns("completed", "failed", "aborted"), false)).toBe(false);
  });

  it("polls quickly while a run is in progress and the event stream is down", () => {
    expect(activeRunPollInterval(detailWithRuns("completed", "running"), false)).toBe(2_000);
    expect(activeRunPollInterval(detailWithRuns("waiting_for_input"), false)).toBe(2_000);
  });

  it("only keeps a slow safety net while the event stream is delivering the run", () => {
    expect(activeRunPollInterval(detailWithRuns("running"), true)).toBe(30_000);
    expect(activeRunPollInterval(detailWithRuns("waiting_for_approval"), true)).toBe(30_000);
  });
});

describe("botChatRefetchInterval", () => {
  const snapshot = { agentId: "bot_research1" } as NativeBotChatSnapshot;

  it("never polls a chat that has no bot, or whose bot status failed to load", () => {
    expect(botChatRefetchInterval(null, false)).toBe(false);
    expect(botChatRefetchInterval(undefined, false)).toBe(false);
    expect(botChatRefetchInterval(null, true)).toBe(false);
  });

  it("polls a bot chat, more slowly while the event stream reports its changes", () => {
    expect(botChatRefetchInterval(snapshot, false)).toBe(15_000);
    expect(botChatRefetchInterval(snapshot, true)).toBe(60_000);
  });
});

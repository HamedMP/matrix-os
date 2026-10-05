jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));
jest.mock("@clerk/clerk-expo", () => ({ useAuth: () => ({}) }));

import { botStatusKnowledge, botStatusRefetchInterval } from "@/lib/queries/use-bot-chat";
import { BotStatusUnsupportedError, type NativeBotChatSnapshot } from "@/lib/requests/bots";

const snapshot = { agentId: "bot_research1", name: "Writer" } as NativeBotChatSnapshot;
const failed = new Error("Bot status could not be loaded. Try again.");

describe("botStatusKnowledge", () => {
  it("is unknown before the first read and after a failed one", () => {
    expect(botStatusKnowledge(undefined)).toBe("unknown");
    expect(botStatusKnowledge({ data: undefined, error: null })).toBe("unknown");
    expect(botStatusKnowledge({ data: undefined, error: failed })).toBe("unknown");
  });

  it("is ordinary once the computer has answered that the chat has no bot", () => {
    expect(botStatusKnowledge({ data: null, error: null })).toBe("ordinary");
  });

  it("is bot while a snapshot is held", () => {
    expect(botStatusKnowledge({ data: snapshot, error: null })).toBe("bot");
    expect(botStatusKnowledge({ data: snapshot, error: failed })).toBe("bot");
  });

  it("is unsupported when the computer has no bot-status route", () => {
    expect(botStatusKnowledge({ data: undefined, error: new BotStatusUnsupportedError() })).toBe("unsupported");
    expect(botStatusKnowledge({ data: snapshot, error: new BotStatusUnsupportedError() })).toBe("unsupported");
  });
});

describe("botStatusRefetchInterval", () => {
  it("keeps a bot's status fresh every 15 seconds", () => {
    expect(botStatusRefetchInterval({ data: snapshot, error: null })).toBe(15_000);
  });

  it("keeps trying at that pace while the status has not been read", () => {
    expect(botStatusRefetchInterval({ data: undefined, error: failed })).toBe(15_000);
    expect(botStatusRefetchInterval(undefined)).toBe(15_000);
  });

  it("stops for a chat confirmed to be ordinary", () => {
    expect(botStatusRefetchInterval({ data: null, error: null })).toBe(false);
  });

  it("looks again once a minute where the route is missing, in case it was only starting up", () => {
    expect(botStatusRefetchInterval({ data: undefined, error: new BotStatusUnsupportedError() })).toBe(60_000);
  });
});

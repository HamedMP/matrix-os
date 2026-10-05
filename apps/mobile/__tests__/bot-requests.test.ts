import { BotStatusUnsupportedError, updateNativeBotModel, fetchNativeBotChat, fetchNativeBotRecipes, instantiateNativeBot,
  resolveNativeBotInteraction, revokeNativeBotGrant } from "@/lib/requests/bots";

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

const gatewayUrl = "https://app.matrix-os.com/vm/pr-2022";
const token = "test-token";
afterEach(() => jest.restoreAllMocks());

it("returns owner-scoped bot status even when the agent library is unavailable", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname;
    const body = path.endsWith("/bot") ? { agentId: "bot_research1" }
      : path.endsWith("/interactions") ? { interactions: [] }
        : path.endsWith("/bot-tasks") ? { tasks: [] }
          : path.endsWith("/authority") ? { agentId: "bot_research1", revision: 1,
            grants: [], connections: [], routines: [], pendingInteractions: [], memory: { items: [] } }
            : { invalid: "library unavailable" };
    return { ok: true, json: async () => body } as Response;
  });
  const snapshot = await fetchNativeBotChat(token, gatewayUrl, "chat_research");
  expect(snapshot?.name).toBe("Your bot");
  expect(snapshot?.authority.agentId).toBe("bot_research1");
  expect(fetchMock.mock.calls.every((call) => (call[1]?.headers as Record<string, string>)?.Authorization === `Bearer ${token}`)).toBe(true);
  expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/chats/chat_research/bot"))).toBe(true);
});

it("reports a computer without the bot route as unsupported, apart from a failed status read", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({ ok: false, status: 404 } as Response);

  await expect(fetchNativeBotChat(token, gatewayUrl, "chat_research")).rejects.toBeInstanceOf(BotStatusUnsupportedError);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("fails a bot status read the computer could not serve with the ordinary error", async () => {
  jest.spyOn(global, "fetch").mockResolvedValue({ ok: false, status: 503 } as Response);

  const failure = await fetchNativeBotChat(token, gatewayUrl, "chat_research").catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(BotStatusUnsupportedError);
  expect((failure as Error).message).toContain("Bot status could not be loaded");
});

it("returns null for a chat the computer says has no bot", async () => {
  jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, status: 200, json: async () => ({ agentId: null }) } as Response);

  expect(await fetchNativeBotChat(token, gatewayUrl, "chat_research")).toBeNull();
});

it("sends a revision-bound answer and uses DELETE for grant revocation", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (input) => ({
    ok: true,
    json: async () => String(input).endsWith("/resolve")
      ? { interaction: { interactionId: "in_abcdefgh", status: "resolved", revision: 2 } }
      : { grantId: "gr_abcdefgh", revokedAt: "2026-09-28T12:00:00.000Z" },
  } as Response));
  await resolveNativeBotInteraction(token, gatewayUrl, "chat_research", "in_abcdefgh", {
    kind: "question", baseRevision: 1, structuredAnswers: { target: ["Acme"] },
  });
  await revokeNativeBotGrant(token, gatewayUrl, "bot_research1", "gr_abcdefgh");
  expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).structuredAnswers).toEqual({ target: ["Acme"] });
  expect(fetchMock.mock.calls[1]![1]!.method).toBe("DELETE");
  expect(String(fetchMock.mock.calls[1]![0])).toContain("/api/chat-agents/bot_research1/grants/gr_abcdefgh");
});

it("lists launch recipes and instantiates one with a stable caller request ID", async () => {
  const recipe = { recipeId: "inbox-triage", version: "v1", name: "Inbox helper",
    description: "Summarize the inbox", output: "A daily brief" };
  const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (input) => ({
    ok: true, json: async () => String(input).endsWith("/bot-recipes") ? { recipes: [recipe] } : {
      agent: { id: "bot_research1", name: "Inbox helper", avatarSeed: "a".repeat(16), revision: 1, status: "active" },
      chatId: "chat_research", operation: "created",
    },
  } as Response));
  expect(await fetchNativeBotRecipes(token, gatewayUrl)).toEqual([recipe]);
  expect((await instantiateNativeBot(token, gatewayUrl, { clientRequestId: "req_abcdefgh", recipe: {
    recipeId: recipe.recipeId, version: recipe.version,
  } })).chatId).toBe("chat_research");
  expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string).clientRequestId).toBe("req_abcdefgh");
});

it("updates only the exact saved bot model under its loaded revision", async () => {
  const selection = { instanceId: "matrix_pi_default", model: "cloudflare:@cf/zai-org/glm-5.3-flash" };
  const agent = { id: "bot_research1", revision: 3, name: "Writer", description: "", instructions: "Write drafts", selection,
    archived: false, createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" };
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, json: async () => agent } as Response);
  await updateNativeBotModel(token, gatewayUrl, agent.id, 2, selection);
  expect(fetchMock.mock.calls[0]![1]!.method).toBe("PATCH");
  expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({ baseRevision: 2, selection });
});

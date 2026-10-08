import {
  AgentRequestError,
  archiveAgent,
  ensureAgentDirectChat,
  fetchAgentDirectChat,
  fetchAgentInteractions,
  fetchAgents,
  fetchAgentTasks,
  instantiateNativeBot,
} from "@/lib/requests/bots";

const gatewayUrl = "https://app.matrix-os.com/vm/alice";
const token = "clerk-token";
const at = "2026-10-08T09:00:00.000Z";
const selection = { instanceId: "matrix_pi_default", model: "cloudflare:@cf/zai-org/glm-5.3-flash" };

function agent(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    revision: 3,
    name: "Inbox helper",
    description: "",
    instructions: "Summarize the inbox",
    selection,
    archived: false,
    createdAt: at,
    updatedAt: at,
    ...extra,
  };
}

const task = {
  taskId: "task_abcdefgh",
  chatId: "chat_inbox",
  agentId: "bot_inbox001",
  status: "running",
  revision: 1,
  updatedAt: at,
};
const interaction = {
  interactionId: "in_abcdefgh",
  chatId: "chat_inbox",
  agentId: "bot_inbox001",
  taskId: "task_abcdefgh",
  kind: "approval",
  blocking: true,
  status: "pending",
  expiresAt: "2026-10-08T10:00:00.000Z",
  revision: 1,
};

function respond(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

async function failureOf(request: Promise<unknown>): Promise<AgentRequestError> {
  try {
    await request;
  } catch (error: unknown) {
    if (error instanceof AgentRequestError) return error;
    throw error;
  }
  throw new Error("Expected the request to fail");
}

const authenticatedGet = expect.objectContaining({
  headers: { Authorization: "Bearer clerk-token" },
  signal: expect.any(AbortSignal),
});

describe("agent requests", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  describe("fetchAgents", () => {
    it("lists the saved agents", async () => {
      const library = { enabled: true, agents: [agent("bot_inbox001", { recipeRef: { recipeId: "inbox-triage", version: "v1" } })] };
      const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(respond(library));

      await expect(fetchAgents(token, gatewayUrl)).resolves.toEqual(library);
      expect(fetchMock).toHaveBeenCalledWith("https://app.matrix-os.com/vm/alice/api/chat-agents", authenticatedGet);
      expect(fetchMock.mock.calls[0]![1]!.method).toBeUndefined();
    });

    it("passes on that agents are switched off", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue(respond({ enabled: false, agents: [] }));

      await expect(fetchAgents(token, gatewayUrl)).resolves.toEqual({ enabled: false, agents: [] });
    });

    it.each([
      ["a failed request", respond({ error: "Agents are temporarily unavailable." }, 503)],
      ["a malformed payload", respond({ enabled: true, agents: [{ id: "bot_inbox001" }] })],
    ])("reports %s with the generic message only", async (_label, response) => {
      jest.spyOn(global, "fetch").mockResolvedValue(response);

      await expect(fetchAgents(token, gatewayUrl)).rejects.toThrow("Agents unavailable. Try again.");
    });
  });

  describe("an agent's chat", () => {
    it("reads the chat an agent already has, or that it has none", async () => {
      const fetchMock = jest.spyOn(global, "fetch")
        .mockResolvedValueOnce(respond({ chatId: "chat_inbox" }))
        .mockResolvedValueOnce(respond({ chatId: null }));

      await expect(fetchAgentDirectChat(token, gatewayUrl, "bot_inbox001")).resolves.toBe("chat_inbox");
      await expect(fetchAgentDirectChat(token, gatewayUrl, "bot_inbox001")).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledWith(
        "https://app.matrix-os.com/vm/alice/api/chat-agents/bot_inbox001/direct-chat",
        authenticatedGet,
      );
      expect(fetchMock.mock.calls[0]![1]!.method).toBeUndefined();
    });

    it("ensures a chat exists with an empty body on the same path", async () => {
      const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(respond({ chatId: "chat_inbox" }));

      await expect(ensureAgentDirectChat(token, gatewayUrl, "bot_inbox001")).resolves.toBe("chat_inbox");
      expect(fetchMock).toHaveBeenCalledWith(
        "https://app.matrix-os.com/vm/alice/api/chat-agents/bot_inbox001/direct-chat",
        expect.objectContaining({
          method: "POST",
          headers: { Authorization: "Bearer clerk-token", "Content-Type": "application/json" },
          body: "{}",
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it.each([
      [404, "not_found", "not_found"],
      [409, "conflict", "conflict"],
      [503, "unavailable", "unavailable"],
      [429, "rate_limited", "unavailable"],
    ] as const)("maps HTTP %s %s to %s when ensuring a chat", async (status, code, reason) => {
      jest.spyOn(global, "fetch").mockResolvedValue(
        respond({ code, message: "Server wording that must not reach the screen" }, status),
      );

      const failure = await failureOf(ensureAgentDirectChat(token, gatewayUrl, "bot_inbox001"));

      expect(failure.reason).toBe(reason);
      expect(failure.message).not.toContain("Server wording");
    });

    it("reports an answer without a chat as unavailable", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue(respond({ chatId: null }));

      expect((await failureOf(ensureAgentDirectChat(token, gatewayUrl, "bot_inbox001"))).reason).toBe("unavailable");
    });

    it("does not call the server for something that is not an agent id", async () => {
      const fetchMock = jest.spyOn(global, "fetch");

      await expect(fetchAgentDirectChat(token, gatewayUrl, "../chat")).rejects.toThrow("Agent unavailable. Try again.");
      expect((await failureOf(ensureAgentDirectChat(token, gatewayUrl, "Bot 1"))).reason).toBe("not_found");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("archiveAgent", () => {
    it("patches the archived flag under the revision the screen loaded", async () => {
      const archived = agent("bot_inbox001", { revision: 4, archived: true });
      const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(respond(archived));

      await expect(archiveAgent(token, gatewayUrl, "bot_inbox001", 3)).resolves.toEqual(archived);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://app.matrix-os.com/vm/alice/api/chat-agents/bot_inbox001",
        expect.objectContaining({
          method: "PATCH",
          headers: { Authorization: "Bearer clerk-token", "Content-Type": "application/json" },
          body: JSON.stringify({ baseRevision: 3, archived: true }),
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it("reports a revision conflict as its own reason, without the server's wording", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue(respond({ error: "Agent changed. Refresh and try again." }, 409));

      const failure = await failureOf(archiveAgent(token, gatewayUrl, "bot_inbox001", 3));

      expect(failure.reason).toBe("conflict");
      expect(failure.message).not.toContain("Agent changed");
    });

    it.each([
      [404, "not_found"],
      [400, "unavailable"],
      [503, "unavailable"],
    ] as const)("maps HTTP %s to %s", async (status, reason) => {
      jest.spyOn(global, "fetch").mockResolvedValue(respond({ error: "Agent or Chat not found" }, status));

      expect((await failureOf(archiveAgent(token, gatewayUrl, "bot_inbox001", 3))).reason).toBe(reason);
    });

    it.each([
      ["a revision the server would reject", "bot_inbox001", 0],
      ["something that is not an agent id", "inbox", 3],
    ])("does not call the server with %s", async (_label, agentId, revision) => {
      const fetchMock = jest.spyOn(global, "fetch");

      await failureOf(archiveAgent(token, gatewayUrl, agentId, revision));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("reports a response that is not an agent as unavailable", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue(respond({ ok: true }));

      expect((await failureOf(archiveAgent(token, gatewayUrl, "bot_inbox001", 3))).reason).toBe("unavailable");
    });
  });

  describe("status reads", () => {
    it("reads the open tasks and pending interactions of an agent's chat", async () => {
      const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (input) =>
        respond(String(input).endsWith("/bot-tasks") ? { tasks: [task] } : { interactions: [interaction] }));

      await expect(fetchAgentTasks(token, gatewayUrl, "chat_inbox")).resolves.toEqual([task]);
      await expect(fetchAgentInteractions(token, gatewayUrl, "chat_inbox")).resolves.toEqual([interaction]);
      expect(fetchMock).toHaveBeenNthCalledWith(
        1, "https://app.matrix-os.com/vm/alice/api/chats/chat_inbox/bot-tasks", authenticatedGet,
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2, "https://app.matrix-os.com/vm/alice/api/chats/chat_inbox/interactions", authenticatedGet,
      );
    });

    it.each([
      ["a failed request", respond({ code: "unavailable", message: "Bots are temporarily unavailable." }, 503)],
      ["a malformed payload", respond({ tasks: [{ taskId: "nope" }], interactions: [{ interactionId: "nope" }] })],
    ])("reports %s with the generic message only", async (_label, response) => {
      jest.spyOn(global, "fetch").mockResolvedValue(response);

      await expect(fetchAgentTasks(token, gatewayUrl, "chat_inbox")).rejects.toThrow("Agent status unavailable. Try again.");
      await expect(fetchAgentInteractions(token, gatewayUrl, "chat_inbox")).rejects.toThrow("Agent status unavailable. Try again.");
    });

    it("does not call the server for something that is not a chat id", async () => {
      const fetchMock = jest.spyOn(global, "fetch");

      await expect(fetchAgentTasks(token, gatewayUrl, "inbox chat")).rejects.toThrow("Agent status unavailable. Try again.");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("instantiateNativeBot", () => {
    const created = {
      agent: { id: "bot_inbox001", name: "Morning brief", avatarSeed: "a".repeat(16), revision: 1, status: "active" },
      chatId: "chat_inbox",
      operation: "created",
    };

    it("sends the name the person chose for the new agent", async () => {
      const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(respond(created, 201));

      await instantiateNativeBot(token, gatewayUrl, {
        clientRequestId: "req_abcdefgh",
        recipe: { recipeId: "inbox-triage", version: "v1" },
        name: "Morning brief",
      });

      expect(String(fetchMock.mock.calls[0]![0])).toBe("https://app.matrix-os.com/vm/alice/api/chat-agents/instantiate");
      expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
        clientRequestId: "req_abcdefgh",
        recipe: { recipeId: "inbox-triage", version: "v1" },
        name: "Morning brief",
      });
    });

    it("leaves the name out when none is given, so the template's own name is used", async () => {
      const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(respond(created, 201));

      await instantiateNativeBot(token, gatewayUrl, {
        clientRequestId: "req_abcdefgh",
        recipe: { recipeId: "inbox-triage", version: "v1" },
      });

      expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).not.toHaveProperty("name");
    });
  });
});

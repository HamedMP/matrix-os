import { fetchConversations } from "@/lib/requests/conversations";

describe("conversation requests", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("loads validated conversations from the selected computer route", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue([
        {
          id: "chat-1",
          preview: "Plan the mobile release",
          messageCount: 4,
          createdAt: 10,
          updatedAt: 20,
        },
      ]),
    } as unknown as Response);

    await expect(fetchConversations(
      "clerk-token",
      "https://app.matrix-os.com/vm/solar-vale?runtime=preview-1",
    )).resolves.toEqual([
      {
        id: "chat-1",
        preview: "Plan the mobile release",
        messageCount: 4,
        createdAt: 10,
        updatedAt: 20,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.com/vm/solar-vale/api/conversations?runtime=preview-1",
      expect.objectContaining({
        headers: { Authorization: "Bearer clerk-token" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("drops malformed entries without exposing unvalidated chat metadata", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue([
        { id: "broken", preview: 42 },
        {
          id: "chat-2",
          preview: "A valid chat",
          messageCount: 2,
          createdAt: 30,
          updatedAt: 40,
        },
      ]),
    } as unknown as Response);

    await expect(fetchConversations(
      "clerk-token",
      "https://app.matrix-os.com/vm/solar-vale",
    )).resolves.toEqual([
      {
        id: "chat-2",
        preview: "A valid chat",
        messageCount: 2,
        createdAt: 30,
        updatedAt: 40,
      },
    ]);
  });
});

import { fetchMatrixComputers } from "../lib/mobile-computers";

describe("fetchMatrixComputers", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("loads and validates the authenticated platform projection", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({
        items: [{
          handle: "pr-919",
          runtimeSlot: "pr-919",
          label: "Preview Computer",
          availability: "available",
          kind: "preview",
          versionLabel: "v2026.07.12",
          gatewayPath: "/vm/pr-919?runtime=pr-919",
          capabilities: ["matrixComputerInventoryV1"],
        }],
        selectedSlot: "pr-919",
        hasMore: false,
        limit: 20,
      }),
    } as unknown as Response);

    await expect(fetchMatrixComputers("clerk-token")).resolves.toEqual({
      ok: true,
      selectedSlot: "pr-919",
      computers: [{
        handle: "pr-919",
        runtimeSlot: "pr-919",
        label: "Preview Computer",
        availability: "available",
        kind: "preview",
        versionLabel: "v2026.07.12",
        gatewayPath: "/vm/pr-919?runtime=pr-919",
        capabilities: ["matrixComputerInventoryV1"],
      }],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.com/api/auth/computers",
      expect.objectContaining({
        headers: { Authorization: "Bearer clerk-token" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("fails closed for malformed paths or responses", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({
        items: [{
          handle: "pr-913",
          runtimeSlot: "pr-913",
          label: "Preview Computer",
          availability: "available",
          kind: "preview",
          versionLabel: "dev",
          gatewayPath: "https://attacker.example.com",
          capabilities: ["matrixComputerInventoryV1"],
        }],
        selectedSlot: null,
        hasMore: false,
        limit: 20,
      }),
    } as unknown as Response);

    await expect(fetchMatrixComputers("clerk-token")).resolves.toEqual({
      ok: false,
      error: "Computers unavailable. Try again.",
    });
  });
});

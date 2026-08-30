jest.mock("@/lib/storage", () => ({
  HOSTED_GATEWAY_URL: "https://app.matrix-os.com",
  getSelectedGatewayConnection: jest.fn(),
}));

import { getSelectedGatewayConnection } from "@/lib/storage";
import { fetchActiveComputer, fetchComputers } from "@/lib/requests/computers";

const computer = {
  handle: "studio-mac",
  runtimeSlot: "primary",
  label: "Main Computer",
  availability: "available" as const,
  kind: "customer" as const,
  versionLabel: "dev",
  gatewayPath: "/vm/studio-mac",
  capabilities: ["matrixComputerInventoryV1"],
};

describe("computer requests", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.mocked(getSelectedGatewayConnection).mockResolvedValue({
      id: "matrix-os-hosted:primary:studio-mac",
      url: "https://app.matrix-os.com/vm/studio-mac",
      runtimeSlot: "primary",
      name: "Studio Mac",
      addedAt: 1,
    });
  });

  it("fetches and validates the authenticated computer inventory", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        items: [computer],
        selectedSlot: "primary",
        hasMore: false,
        limit: 20,
      }),
    } as unknown as Response);

    await expect(fetchComputers("clerk-token")).resolves.toMatchObject({
      items: [computer],
      selectedSlot: "primary",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.com/api/auth/computers",
      expect.objectContaining({
        headers: { Authorization: "Bearer clerk-token" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("returns the selected computer for reuse by authenticated surfaces", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        items: [computer],
        selectedSlot: "primary",
        hasMore: false,
        limit: 20,
      }),
    } as unknown as Response);

    await expect(fetchActiveComputer("clerk-token")).resolves.toEqual(computer);
  });

  it("rejects malformed server responses with a safe error", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ items: [{ label: "Broken" }] }),
    } as unknown as Response);

    await expect(fetchComputers("clerk-token")).rejects.toThrow("Computers unavailable. Try again.");
  });
});

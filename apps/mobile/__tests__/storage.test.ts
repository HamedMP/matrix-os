import * as SecureStore from "expo-secure-store";
import {
  generateId,
  getMobileJourneyGatewayUrl,
  getSelectedGatewayConnection,
  isHostedGatewayUrl,
  resolveMobileAppSessionLaunchUrl,
  saveSelectedGatewayBasicAuth,
  saveSelectedHostedComputer,
} from "../lib/storage";

describe("storage", () => {
  describe("generateId", () => {
    it("generates unique IDs", () => {
      const id1 = generateId();
      const id2 = generateId();
      expect(id1).not.toBe(id2);
    });

    it("generates string IDs", () => {
      const id = generateId();
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    });
  });

  describe("hosted computer selection", () => {
    beforeEach(() => {
      jest.mocked(SecureStore.getItemAsync).mockReset();
      jest.mocked(SecureStore.setItemAsync).mockReset();
    });

    it("recognizes only bounded same-origin Matrix computer routes as hosted", () => {
      expect(isHostedGatewayUrl("https://app.matrix-os.com/vm/pr-913")).toBe(true);
      expect(isHostedGatewayUrl("https://app.matrix-os.com/vm/pr-919?runtime=pr-919")).toBe(true);
      expect(isHostedGatewayUrl("https://app.matrix-os.com/vm/pr-919?runtime=pr-919&token=secret")).toBe(false);
      expect(isHostedGatewayUrl("https://app.matrix-os.com/vm/../admin")).toBe(false);
      expect(isHostedGatewayUrl("https://preview.example.com/vm/pr-913")).toBe(false);
    });

    it("keeps platform journey requests on the canonical hosted origin after a computer switch", () => {
      expect(getMobileJourneyGatewayUrl("https://app.matrix-os.com/vm/pr-914"))
        .toBe("https://app.matrix-os.com");
      expect(getMobileJourneyGatewayUrl("https://matrix.example.test"))
        .toBe("https://matrix.example.test");
    });

    it("routes hosted app sessions through the canonical platform origin", () => {
      expect(resolveMobileAppSessionLaunchUrl(
        "https://app.matrix-os.com/vm/pr-914",
        "/apps/notes/?session=pr-914.token",
      )).toBe("https://app.matrix-os.com/apps/notes/?session=pr-914.token");
    });

    it("keeps self-hosted app sessions on the selected gateway", () => {
      expect(resolveMobileAppSessionLaunchUrl(
        "https://matrix.example.test",
        "/apps/notes/?session=token",
      )).toBe("https://matrix.example.test/apps/notes/?session=token");
    });

    it("persists a selected computer without credentials and restores its label", async () => {
      jest.mocked(SecureStore.setItemAsync).mockResolvedValue(undefined);

      const selected = await saveSelectedHostedComputer({
        handle: "pr-919",
        runtimeSlot: "pr-919",
        label: "Preview Computer",
        availability: "available",
        kind: "preview",
        versionLabel: "v2026.07.12",
        gatewayPath: "/vm/pr-919?runtime=pr-919",
        capabilities: ["matrixComputerInventoryV1"],
      });

      expect(selected).toMatchObject({
        id: "matrix-os-hosted:pr-919:pr-919",
        url: "https://app.matrix-os.com/vm/pr-919?runtime=pr-919",
        name: "Preview Computer",
        runtimeSlot: "pr-919",
      });
      expect(selected.token).toBeUndefined();
      const saved = jest.mocked(SecureStore.setItemAsync).mock.calls[0]?.[1];
      expect(saved).not.toContain("token");

      jest.mocked(SecureStore.getItemAsync).mockResolvedValue(saved ?? null);
      await expect(getSelectedGatewayConnection()).resolves.toEqual(selected);
    });

    it("does not persist a self-hosted Basic Auth credential", async () => {
      jest.mocked(SecureStore.setItemAsync).mockResolvedValue(undefined);

      const selected = await saveSelectedGatewayBasicAuth(
        "https://matrix.example.com",
        "owner",
        "password",
      );

      expect(selected.token).toMatch(/^Basic /);
      expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
        "matrix_os_gateway_connection",
        expect.not.stringContaining("Basic"),
      );
      const persisted = jest.mocked(SecureStore.setItemAsync).mock.calls[0]?.[1];
      expect(persisted).not.toContain("token");
    });
  });
});

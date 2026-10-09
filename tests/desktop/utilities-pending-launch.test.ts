import { afterEach, expect, it, vi } from "vitest";
import { EmbedService } from "@desktop/main/embeds/embed-service";
vi.mock("electron", () => ({ net: { request: vi.fn() }, session: { fromPartition: vi.fn() } }));
afterEach(() => vi.restoreAllMocks());
it("closes an exact never-mounted Utilities launch and prevents a late retry from attaching", async () => {
  const service = new EmbedService({ getWindow: () => null, getGatewayOrigin: () => "https://gateway.test", getToken: () => "fixture", emitState: vi.fn() });
  const internals = service as unknown as { fetchLaunchToken: () => Promise<{ launchUrl: string; expiresAt: number }>; manager: { open: (...args: unknown[]) => string } };
  const token = vi.spyOn(internals, "fetchLaunchToken").mockRejectedValueOnce(new Error("synthetic"));
  const open = vi.spyOn(internals.manager, "open");
  const failed = await service.open({ kind: "app", slug: "utilities", appIdentity: "utilities", bounds: { x: 0, y: 0, width: 500, height: 500 } });
  expect(failed.state).toBe("failed"); expect(open).not.toHaveBeenCalled();
  let resolve!: (value: { launchUrl: string; expiresAt: number }) => void;
  token.mockImplementation(() => new Promise(done => { resolve = done; }));
  const retry = service.retryAuth(failed.embedId);
  expect(await service.closeUtilities()).toBe(true);
  resolve({ launchUrl: "/apps/utilities/", expiresAt: Date.now() + 60_000 });
  expect(await retry).toBe(false); expect(open).not.toHaveBeenCalled();
  expect(await service.closeUtilities()).toBe(false);
  service.closeAll();
});
it("does not remove another app's pending launch", async () => {
  const service = new EmbedService({ getWindow: () => null, getGatewayOrigin: () => "https://gateway.test", getToken: () => "fixture", emitState: vi.fn() });
  vi.spyOn(service as any, "fetchLaunchToken").mockRejectedValue(new Error("synthetic"));
  const failed = await service.open({ kind: "app", slug: "notes", appIdentity: "notes", bounds: { x: 0, y: 0, width: 500, height: 500 } });
  expect(await service.closeUtilities()).toBe(false);
  expect(service.close(failed.embedId)).toBe(true);
  service.closeAll();
});

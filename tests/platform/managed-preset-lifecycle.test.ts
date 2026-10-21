import { describe, expect, it, vi } from "vitest";
import { createManagedPresetLifecycle } from "../../packages/platform/src/managed-preset-lifecycle.js";

function fixture(presetId: string | null = "posthog_oauth") {
  const row = { id: "server", user_id: "owner", preset_id: presetId };
  const db = { getCustomMcpServerForBroker: vi.fn(async (_id: string, owner: string) => owner === "owner" ? row : null) };
  const oauth = { start: vi.fn(async () => "https://auth.example/authorize"), complete: vi.fn(async () => ({ serverId: row.id, revision: 7 })) };
  const bokioOAuth = { start: vi.fn(async () => "https://api.bokio.se/v1/authorize"), complete: vi.fn(async () => ({ serverId: row.id, revision: 7 })) };
  const activatePreset = vi.fn(async () => row);
  const bokioBroker = { disconnect: vi.fn(async () => true) };
  return { row, db, oauth, bokioOAuth, bokioBroker, activatePreset, lifecycle: createManagedPresetLifecycle({ db, oauth, bokioOAuth, bokioBroker, activatePreset, decodeState: () => ({ userId: "owner", kind: presetId === "bokio" ? "bokio" : undefined }) }) };
}
describe("managed preset startup lifecycle", () => {
  it("activates reviewed managed tools only after the explicit OAuth callback succeeds", async () => {
    const f = fixture("loops");
    await f.lifecycle.oauth.complete("state", "code");
    expect(f.activatePreset).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner", presetId: "loops", requiredTools: [], expectedRevision: 7 }));
    f.oauth.complete.mockRejectedValueOnce(new Error("token failed"));
    await expect(f.lifecycle.oauth.complete("state", "code")).rejects.toThrow();
    expect(f.activatePreset).toHaveBeenCalledTimes(1);
    const generic = fixture(null); await generic.lifecycle.oauth.complete("state", "code");
    expect(generic.activatePreset).not.toHaveBeenCalled();
  });
  it("uses reviewed read scopes on raw PostHog reconnect", async () => {
    const f = fixture(); await f.lifecycle.oauth.start("owner", "server");
    expect(f.oauth.start).toHaveBeenCalledWith("owner", "server", { scopes: ["project:read", "organization:read", "insight:read"] });
  });
  it("keeps generic reconnect and encrypted state dispatcher behavior", async () => {
    const f = fixture(null); await f.lifecycle.oauth.start("owner", "server");
    expect(f.oauth.start).toHaveBeenCalledWith("owner", "server");
    await f.lifecycle.oauth.complete("state", "code"); expect(f.oauth.complete).toHaveBeenCalledWith("state", "code");
    await expect(f.lifecycle.oauth.start("foreign", "server")).rejects.toThrow();
  });
  it("uses Bokio connect, callback and exact selected removal on both lifecycle paths", async () => {
    const f = fixture("bokio"); await f.lifecycle.oauth.start("owner", "server"); await f.lifecycle.oauth.complete("state", "code");
    expect(f.bokioOAuth.start).toHaveBeenCalledWith("owner", "server"); expect(f.bokioOAuth.complete).toHaveBeenCalledWith("state", "code");
    expect(await f.lifecycle.removeManagedPreset("owner", f.row, false)).toBe(true);
    expect(await f.lifecycle.removeManagedPreset("owner", f.row, true)).toBe(true);
    expect(f.bokioBroker.disconnect).toHaveBeenCalledWith("owner", "server");
    expect(await f.lifecycle.removeManagedPreset("owner", { ...f.row, preset_id: null }, false)).toBe(false);
    await expect(f.lifecycle.removeManagedPreset("foreign", f.row, false)).rejects.toThrow();
  });
  it("never declares success after failed or ambiguous Bokio revocation", async () => {
    const f = fixture("bokio"); f.bokioBroker.disconnect.mockResolvedValue(false);
    await expect(f.lifecycle.removeManagedPreset("owner", f.row, false)).rejects.toThrow();
    f.bokioBroker.disconnect.mockRejectedValue(new Error("failed"));
    await expect(f.lifecycle.removeManagedPreset("owner", f.row, true)).rejects.toThrow();
  });
});

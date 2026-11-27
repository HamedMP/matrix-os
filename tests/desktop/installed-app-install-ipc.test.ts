import { describe, expect, it, vi } from "vitest";
import {
  InstalledAppsUnavailableError,
  registerInstalledAppsIpc,
  type InstalledAppsControl,
} from "../../desktop/src/main/installed-apps/install-ipc";
import { NativeAppOpenError } from "../../desktop/src/main/embeds/native-app-open";
import { InstalledAppLimitError } from "../../desktop/src/main/installed-apps/record-store";
import type { InstalledAppRecord } from "../../desktop/src/main/installed-apps/record";
import { INVOKE_CHANNELS } from "../../desktop/src/shared/ipc-contract";
import { windowMayInvoke } from "../../desktop/src/shared/terminal-window";

const ID = "6f1c2a4e-2b7d-4c1a-9f3e-1a2b3c4d5e6f";
const RECORD: InstalledAppRecord = {
  installId: ID, appIdentity: "notes", slug: "notes", runtimeSlot: "primary", name: "Notes",
  iconSha256: "a".repeat(64), bundlePath: "/home/me/.local/share/applications/secret.desktop",
  cdHashes: ["b".repeat(40)], createdAt: "2026-11-27T10:00:00.000Z",
};
const MAIN = { sender: "main" };
const OTHER = { sender: "app-view" };

/** `null` stands for a control that is not available yet. */
function harness(control: Partial<InstalledAppsControl> | null = {}) {
  const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
  const full: InstalledAppsControl = {
    platform: () => "linux",
    list: async () => [RECORD],
    install: async () => RECORD,
    uninstall: async () => true,
    open: async () => undefined,
    show: async () => true,
    ...(control ?? { platform: () => null }),
  };
  registerInstalledAppsIpc({ handle: (channel, listener) => { handlers.set(channel, listener); } }, {
    isMainWindowSender: (event) => event === MAIN,
    control: full,
  });
  const call = (channel: string, payload: unknown, event: unknown = MAIN) => handlers.get(channel)!(event, payload);
  return { handlers, call, control: full };
}

describe("installed apps IPC", () => {
  it("registers every installed-apps channel of the contract", () => {
    const { handlers } = harness();
    expect([...handlers.keys()].sort()).toEqual(Object.keys(INVOKE_CHANNELS).filter((channel) => channel.startsWith("installed-apps:")).sort());
  });

  it("refuses to register without its control object", () => {
    const ipc = { handle: vi.fn() };
    for (const control of [undefined, null, {}, { platform: () => null }]) {
      expect(() => registerInstalledAppsIpc(ipc, { isMainWindowSender: () => true, control: control as never })).toThrow();
    }
    expect(ipc.handle).not.toHaveBeenCalled();
  });

  it("uses the control object it was registered with", async () => {
    const list = vi.fn(async () => [RECORD]);
    const { call } = harness({ list });
    await call("installed-apps:list", {});
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("keeps the channels away from the Terminal window", () => {
    for (const channel of ["installed-apps:list", "installed-apps:install", "installed-apps:uninstall"]) {
      expect(windowMayInvoke("terminal", channel, {})).toBe(false);
      expect(windowMayInvoke("main", channel, {})).toBe(true);
    }
  });

  it("lists installs without paths or hashes", async () => {
    const { call } = harness();
    await expect(call("installed-apps:list", {})).resolves.toEqual({
      available: true,
      platform: "linux",
      apps: [{ installId: ID, slug: "notes", appIdentity: "notes", runtimeSlot: "primary", name: "Notes" }],
    });
  });

  it("reports no capability when install is unavailable", async () => {
    await expect(harness(null).call("installed-apps:list", {})).resolves.toEqual({ available: false });
    await expect(harness({ platform: () => null }).call("installed-apps:list", {})).resolves.toEqual({ available: false });
    await expect(harness(null).call("installed-apps:install", { name: "Notes", path: "matrix-app:notes" }))
      .resolves.toEqual({ ok: false, error: "unavailable" });
  });

  it("rejects senders other than the main window", async () => {
    const install = vi.fn(async () => RECORD);
    const { call } = harness({ install });
    await expect(call("installed-apps:install", { name: "Notes", path: "matrix-app:notes" }, OTHER)).rejects.toThrow("invalid request");
    await expect(call("installed-apps:list", {}, OTHER)).rejects.toThrow("invalid request");
    expect(install).not.toHaveBeenCalled();
  });

  it("validates install references and install ids before calling main", async () => {
    const install = vi.fn(async () => RECORD);
    const uninstall = vi.fn(async () => true);
    const { call } = harness({ install, uninstall });
    for (const payload of [
      { name: "Notes", path: "/home/me/apps/notes" },
      { name: "Notes", path: "apps/../etc" },
      { name: "Notes", path: "matrix-app:notes", bundlePath: "/tmp/x" },
      { name: "", path: "matrix-app:notes" },
    ]) {
      await expect(call("installed-apps:install", payload)).rejects.toThrow("invalid request");
    }
    for (const payload of [{ installId: "notes" }, { installId: `${ID}/../x` }, {}]) {
      await expect(call("installed-apps:uninstall", payload)).rejects.toThrow("invalid request");
    }
    expect(install).not.toHaveBeenCalled();
    expect(uninstall).not.toHaveBeenCalled();
  });

  it("installs a catalog reference and returns its summary", async () => {
    const install = vi.fn(async () => RECORD);
    const { call } = harness({ install });
    await expect(call("installed-apps:install", { name: "Notes", path: "matrix-app:notes" })).resolves.toEqual({
      ok: true, app: { installId: ID, slug: "notes", appIdentity: "notes", runtimeSlot: "primary", name: "Notes" },
    });
    expect(install).toHaveBeenCalledWith({ name: "Notes", path: "matrix-app:notes" });
  });

  it("maps failures to allowlisted codes and never returns their messages", async () => {
    const cases: Array<[unknown, string]> = [
      [new NativeAppOpenError("auth-required", "desktop authentication required"), "auth-required"],
      [new NativeAppOpenError("not-found", "installed app unavailable"), "not-found"],
      [new NativeAppOpenError("catalog-unavailable", "catalog"), "unavailable"],
      [new InstalledAppLimitError(), "limit"],
      [new InstalledAppsUnavailableError(), "unavailable"],
      [new Error("EACCES: permission denied, open '/home/me/.local/share/applications/x'"), "failed"],
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const [error, code] of cases) {
      const { call } = harness({ install: async () => { throw error; } });
      const result = await call("installed-apps:install", { name: "Notes", path: "matrix-app:notes" });
      expect(result).toEqual({ ok: false, error: code });
      expect(JSON.stringify(result)).not.toContain("/home/me");
    }
    expect(warn.mock.calls.flat().join(" ")).not.toContain("/home/me");
    warn.mockRestore();
  });

  it("uninstalls by install id and reports a missing install", async () => {
    const uninstall = vi.fn(async (installId: string) => installId === ID);
    const { call } = harness({ uninstall });
    await expect(call("installed-apps:uninstall", { installId: ID })).resolves.toEqual({ ok: true });
    await expect(call("installed-apps:uninstall", { installId: "0b6f7c8d-1e2f-4a3b-8c4d-5e6f7a8b9c0d" }))
      .resolves.toEqual({ ok: false, error: "not-found" });
  });

  it("opens and reveals installs", async () => {
    const open = vi.fn(async () => undefined);
    const show = vi.fn(async () => false);
    const { call } = harness({ open, show });
    await expect(call("installed-apps:open", { installId: ID })).resolves.toEqual({ ok: true });
    await expect(call("installed-apps:show", { installId: ID })).resolves.toEqual({ ok: false });
    expect(open).toHaveBeenCalledWith(ID);
    expect(show).toHaveBeenCalledWith(ID);
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { APP_CAPABILITY_CHANNEL } from "../../packages/contracts/src/app-capabilities";
import { APP_FILES_CHANNEL, appFileVersion } from "../../packages/contracts/src/app-files";
import { NativeAppBridge } from "../../desktop/src/main/embeds/native-app-bridge";
import { createNativeAppOwnerRequesters } from "../../desktop/src/main/embeds/native-app-owner-requesters";
import { NATIVE_APP_OPEN_REQUEST_CHANNEL } from "../../desktop/src/shared/native-app-files";

vi.mock("electron", () => ({ contextBridge: {}, ipcRenderer: {} }));

type Handler = (event: unknown, input: unknown) => Promise<unknown>;

const STAT = { path: "Documents/plan.docx", size: 3, modifiedAt: "2026-11-23T10:00:00.000Z", version: appFileVersion(3, 1n) };

/** Builds the bridge the way the main process does: required options plus the owner requesters. */
function mainProcessBridge(fetchFn: typeof fetch) {
  const owner = createNativeAppOwnerRequesters({ getGatewayOrigin: () => "https://gateway.test", getToken: () => "owner-token", fetchFn });
  const bridge = new NativeAppBridge({
    authGeneration: () => 0, generate: vi.fn(), request: vi.fn(), gatewayRequest: vi.fn(),
    gatewayOrigin: () => "https://gateway.test", ...owner,
  });
  const handlers = new Map<string, Handler>();
  bridge.registerIpc({ handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as never);
  return { bridge, handlers };
}

describe("Electron main wiring of the app file bridge", () => {
  it("registers the files and open-request channels next to the capability channel", () => {
    const { handlers } = mainProcessBridge(vi.fn() as never);
    expect(handlers.has(APP_CAPABILITY_CHANNEL)).toBe(true);
    expect(handlers.has(APP_FILES_CHANNEL)).toBe(true);
    expect(handlers.has(NATIVE_APP_OPEN_REQUEST_CHANNEL)).toBe(true);
  });

  it("forwards a registered app's file request to the gateway file route with the owner token", async () => {
    const fetchFn = vi.fn(async () => Response.json(STAT));
    const { bridge, handlers } = mainProcessBridge(fetchFn as never);
    bridge.register(7, "docs");
    const frame = {};
    const event = { senderFrame: frame, sender: { id: 7, mainFrame: frame, getURL: () => "https://gateway.test/apps/docs/", isDestroyed: () => false } };
    await expect(handlers.get(APP_FILES_CHANNEL)!(event, { kind: "files.stat", path: "Documents/plan.docx" })).resolves.toEqual(STAT);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://gateway.test/api/bridge/files");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer owner-token");
    expect(JSON.parse(init.body as string)).toEqual({ app: "docs", input: { kind: "files.stat", path: "Documents/plan.docx" } });
  });

  it("is what the main process passes to the bridge", () => {
    const source = readFileSync(resolve(__dirname, "../../desktop/src/main/index.ts"), "utf8");
    const construction = source.slice(source.indexOf("new NativeAppBridge({"));
    const end = construction.indexOf("\n      });");
    expect(end).toBeGreaterThan(0);
    expect(construction.slice(0, end)).toMatch(/\.\.\.createNativeAppOwnerRequesters\(\{/);
  });
});

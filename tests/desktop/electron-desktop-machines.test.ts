// The Electron transport for the Desktops group (spec 2716).
import { describe, expect, it, vi } from "vitest";
import { DESKTOP_LINK_CLIENT_TIMEOUT_MS } from "@matrix-os/contracts/desktop-link";
import { desktopLinkRequest } from "@desktop/renderer/src/features/terminal/ElectronDesktopMachines";

describe("Electron desktop link transport", () => {
  // Fault detected (review): the API client's 10 s default cut a terminal start that
  // waits for the owner's approval on the desktop; the terminal still started there.
  it("lets every desktop link request wait as long as the shared client allows", async () => {
    const seen: Array<{ timeoutMs?: number }> = [];
    const api = {
      getText: vi.fn(async (_path: string, options: { timeoutMs?: number }) => { seen.push(options); return "{}"; }),
      post: vi.fn(async (_path: string, _body: unknown, options: { timeoutMs?: number }) => { seen.push(options); return {}; }),
      delete: vi.fn(async (_path: string, _body: unknown, options: { timeoutMs?: number }) => { seen.push(options); return {}; }),
    };
    const request = desktopLinkRequest(api as never);
    const signal = AbortSignal.timeout(1_000);
    await request("/api/desktop-link/machines", { method: "GET", signal });
    await request("/api/desktop-link/machines/a/terminals", { method: "POST", signal, body: "{}" });
    await request("/api/desktop-pairing/a", { method: "DELETE", signal, body: JSON.stringify({ revision: 1 }) });
    expect(seen.map((options) => options.timeoutMs)).toEqual([DESKTOP_LINK_CLIENT_TIMEOUT_MS, DESKTOP_LINK_CLIENT_TIMEOUT_MS, DESKTOP_LINK_CLIENT_TIMEOUT_MS]);
  });
});

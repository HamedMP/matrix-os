// @vitest-environment jsdom
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserSurfaceProps } from "../../packages/ui/src/browser/types";
import { RemoteBrowserView } from "../../shell/src/components/RemoteBrowserView";
let props: BrowserSurfaceProps;
vi.mock("@matrix-os/ui", () => ({ BrowserSurface: (value: BrowserSurfaceProps) => { props = value; return <div/>; } }));
vi.mock("../../shell/src/lib/gateway", () => ({ getGatewayUrl: () => "https://app.matrix-os.com/vm/pr-2526" }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("web Browser surface adapter", () => {
  it("renews only the selected runtime app cookie with credentialed abortable HTTP", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ expiresAt: Date.now() + 600_000 })));
    const open = vi.fn(); render(<RemoteBrowserView surface="browser" onOpenCloudDesktop={open}/>);
    const controller = new AbortController(); await props.ensureSession(controller.signal);
    expect(props.onOpenCloudDesktop).toBe(open);
    expect(fetch).toHaveBeenCalledWith("https://app.matrix-os.com/vm/pr-2526/api/apps/browser-lab/session", expect.objectContaining({
      method: "POST", credentials: "include", body: "{}", redirect: "error", signal: expect.any(AbortSignal),
    }));
    controller.abort(); expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
  it("does not expose a failed session response to the surface", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("private provider detail", { status: 503 })));
    render(<RemoteBrowserView surface="desktop" active={false}/>);
    await expect(props.ensureSession(new AbortController().signal)).rejects.toThrow("Browser session unavailable");
    expect(props.active).toBe(false);
  });
});

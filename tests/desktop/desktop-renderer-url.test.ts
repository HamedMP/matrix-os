import { describe, expect, it } from "vitest";
import {
  DESKTOP_DEV_RENDERER_HOST,
  desktopDevHostResolverRules,
  resolveDesktopRendererUrl,
} from "@desktop/main/renderer-url";

describe("Desktop renderer URL", () => {
  it("keeps the local renderer in a potentially trustworthy localhost origin", () => {
    expect(DESKTOP_DEV_RENDERER_HOST).toMatch(/(?:^|\.)localhost$/);
  });

  it("maps the local Vite renderer onto an allowed Matrix development hostname", () => {
    expect(resolveDesktopRendererUrl("http://127.0.0.1:5173/")).toBe(
      `http://${DESKTOP_DEV_RENDERER_HOST}:5173/`,
    );
    expect(resolveDesktopRendererUrl("http://localhost:5173/path?mode=desktop")).toBe(
      `http://${DESKTOP_DEV_RENDERER_HOST}:5173/path?mode=desktop`,
    );
    expect(desktopDevHostResolverRules()).toBe(
      `MAP ${DESKTOP_DEV_RENDERER_HOST} 127.0.0.1`,
    );
  });

  it("keeps the development renderer inside the proxy-exempt localhost namespace", () => {
    expect(new URL(resolveDesktopRendererUrl("http://127.0.0.1:5173/")!).hostname).toBe(
      "desktop.localhost",
    );
  });

  it("does not rewrite non-local or malformed renderer URLs", () => {
    expect(resolveDesktopRendererUrl("https://app.matrix-os.com/desktop")).toBe(
      "https://app.matrix-os.com/desktop",
    );
    expect(resolveDesktopRendererUrl("not a URL")).toBe("not a URL");
    expect(resolveDesktopRendererUrl(undefined)).toBeUndefined();
  });
});

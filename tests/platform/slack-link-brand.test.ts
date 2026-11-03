import { describe, expect, it, vi } from "vitest";
import { createSlackLinkPage } from "../../packages/platform/src/slack/link-page.js";

vi.mock("@matrix-os/brand/tokens", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../packages/brand/src/tokens.js")>();
  return {
    ...original,
    desktopPalette: {
      ...original.desktopPalette,
      canvas: "#123450", paper: "#123451", forest: "#123452", forestHover: "#123453",
      coral: "#123454", danger: "#123455", textMuted: "#123456", green: "#123457",
    },
    palette: { ...original.palette, brandInk: "#123458", border: "#123459" },
    desktopFonts: { ...original.desktopFonts, sans: "Synthetic Brand Sans, sans-serif" },
  };
});

describe("Slack account-link shared brand styling", () => {
  it.each([null, "user_synthetic"])("follows shared tokens for signed-in actor %s", async (actor) => {
    const app = createSlackLinkPage({ resolveActor: async () => actor });
    const response = await app.request(`/slack/link?token=${"a".repeat(43)}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    const style = html.match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1];
    expect(style).toBeDefined();
    for (let slot = 0; slot <= 9; slot++) expect(style).toContain(`#12345${slot}`);
    expect(style).toContain("Synthetic Brand Sans, sans-serif");
    const nonce = response.headers.get("Content-Security-Policy")?.match(/style-src 'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();
    expect(html).toContain(`<style nonce="${nonce}">`);
    expect(html).toContain(actor ? 'id="connect"' : "/sign-in?redirect_url=");
  });
});

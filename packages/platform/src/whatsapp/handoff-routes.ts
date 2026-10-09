import { Hono } from "hono";
import { parseMatrixHandoff } from "@matrix-os/contracts";
import { desktopFonts, desktopPalette, palette } from "@matrix-os/brand/tokens";
import { rabbitMarkSvg } from "@matrix-os/brand/marks";

export const MOBILE_ASSOCIATION = {
  applinks: {
    apps: [],
    details: [{ appID: "PX4JL74Y2K.com.matrixos.mobile", paths: ["/open"] }],
  },
};
function attr(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
/** Public navigation only. No credentials, connection permits or automatic account mutation. */
export function createMessagingHandoffRoutes() {
  const app = new Hono();
  app.get("/.well-known/apple-app-site-association", (c) => {
    c.header("Cache-Control", "public, max-age=3600");
    return c.json(MOBILE_ASSOCIATION);
  });
  app.get("/open", (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    c.header(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    const target = parseMatrixHandoff(new URL(c.req.url).searchParams);
    if (!target)
      return c.text("This link is invalid. Open Matrix to continue.", 400);
    const query = new URLSearchParams({ chat: target.chatId });
    const native = "matrixos://open?" + query;
    const web =
      "/?" +
      new URLSearchParams({
        chat: target.chatId,
        launch: "__chat__",
        runtime: "primary",
      });
    return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Continue in Matrix</title><style>
    *{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;background:${desktopPalette.paper};color:${desktopPalette.forest};font-family:${desktopFonts.display}}main{width:100%;max-width:420px;padding:32px;border:1px solid ${palette.border};border-radius:24px}svg{width:44px;height:44px}h1{font-size:28px;line-height:1.2}p{line-height:1.6;color:${desktopPalette.textMuted}}a{display:block;text-align:center;padding:14px;border-radius:12px;text-decoration:none;margin-top:12px;background:${desktopPalette.forest};color:${desktopPalette.paper}}a.secondary{background:transparent;color:inherit;border:1px solid ${palette.border}}</style></head><body><main>${rabbitMarkSvg("mark")}<h1>Continue with your Matrix.</h1><p>Open this Chat to review your agent’s progress and anything that needs your attention.</p><a href="${attr(native)}">Open Matrix app</a><a class="secondary" href="${attr(web)}">Continue in browser</a><p>You’ll sign in to your own Matrix account. Don’t have the app? Continue in your browser.</p></main></body></html>`);
  });
  return app;
}

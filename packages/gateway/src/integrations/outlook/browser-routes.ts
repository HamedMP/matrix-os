import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod/v4";
import { OutlookError } from "./http.js";
import { outlookStateHash, outlookStateSchema, type OutlookLifecycle } from "./lifecycle.js";

const browserPath = "/outlook/oauth";
const callbackBody = z.object({
  state: outlookStateSchema,
  code: z.string().min(1).max(8192).regex(/^[^\s\x00-\x1f\x7f]+$/).optional(),
  error: z.string().min(1).max(128).optional(),
}).refine(body => Boolean(body.code) !== Boolean(body.error));
const cookieName = (state: string) => `__Host-matrix-outlook-${outlookStateHash(state).slice(0, 32)}`;
const cookieOptions = { httpOnly: true, secure: true, sameSite: "None" as const, path: "/" };
const completePage = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Outlook connected</title><h1>Outlook connected</h1><p>Return to Matrix to use your account. You can close this tab.</p></html>';

export function createOutlookBrowserRoutes(options: {
  lifecycle: OutlookLifecycle;
  resolveUserId: (context: Context) => Promise<string | null>;
}) {
  const app = new Hono();
  app.use(`${browserPath}/*`, async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    await next();
  });

  app.get(`${browserPath}/authorize`, async c => {
    const state = outlookStateSchema.safeParse(c.req.query("state"));
    if (!state.success || c.req.queries("state")?.length !== 1) return c.json({ error: "Connection unavailable" }, 400);
    const userId = await options.resolveUserId(c);
    if (!userId) return c.json({ error: "Sign in to Matrix to connect Outlook" }, 401);
    try {
      const result = await options.lifecycle.authorization(state.data, userId);
      setCookie(c, cookieName(state.data), result.browserProof, { ...cookieOptions, maxAge: 600 });
      return c.redirect(result.url);
    } catch (error: unknown) {
      console.warn("[outlook] Consent launch rejected", error instanceof Error ? error.name : "UnknownError");
      return c.json({ error: "Connection unavailable. Start again from Matrix." }, 403);
    }
  });

  app.post(`${browserPath}/callback`, bodyLimit({ maxSize: 16_384 }), async c => {
    if (c.req.header("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !== "application/x-www-form-urlencoded") {
      return c.json({ error: "Connection unavailable" }, 400);
    }
    try {
      const fields = new URLSearchParams(await c.req.text());
      if (["state", "code", "error"].some(field => fields.getAll(field).length > 1)) {
        return c.json({ error: "Connection unavailable" }, 400);
      }
      const parsed = callbackBody.safeParse(Object.fromEntries(fields));
      if (!parsed.success) return c.json({ error: "Connection unavailable" }, 400);
      const name = cookieName(parsed.data.state);
      const proof = getCookie(c, name);
      if (!proof || proof.length > 512 || !/^s1\.[A-Za-z0-9_.-]+$/.test(proof)) {
        return c.json({ error: "Connection unavailable. Start again from Matrix." }, 403);
      }
      deleteCookie(c, name, cookieOptions);
      const result = await options.lifecycle.complete(parsed.data.state, proof, parsed.data.code, c.req.raw.signal);
      if (!result) return c.json({ error: "Outlook connection was not completed" }, 400);
      if (result.redirectUri) return c.redirect(result.redirectUri, 303);
      return c.html(completePage);
    } catch (error: unknown) {
      if (error instanceof OutlookError && error.code === "account_mismatch") return c.json({ error: error.message }, 409);
      console.warn("[outlook] Consent callback failed", error instanceof Error ? error.name : "UnknownError");
      return c.json({ error: "Connection unavailable. Start again from Matrix." }, 502);
    }
  });
  return app;
}

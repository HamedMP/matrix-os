import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { ActorIdSchema, SlackTokenSchema } from "./types.js";
import type { SlackAuthorityDependencies } from "./types.js";

/** An account session is sufficient; no personal computer, billing or private OS boot is required. */
export function createSlackLinkPage(options: Pick<SlackAuthorityDependencies, "resolveActor">): Hono {
  const app = new Hono();
  app.get("/slack/link", async (c) => {
    c.header("Cache-Control", "no-store"); c.header("Referrer-Policy", "no-referrer");
    const token = SlackTokenSchema.safeParse(c.req.query("token"));
    if (!token.success) return c.json({ error: "Invalid request" }, 422);
    const nonce = randomBytes(24).toString("base64url");
    c.header("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
    const signedIn = ActorIdSchema.safeParse(await options.resolveActor(c)).success;
    const returnPath = `/slack/link?token=${token.data}`;
    const content = signedIn
      ? `<button id="connect">Connect my Matrix</button><p id="status" role="status"></p>
<script nonce="${nonce}">document.getElementById('connect').addEventListener('click',async()=>{const button=document.getElementById('connect');const status=document.getElementById('status');button.disabled=true;status.textContent='Connecting…';try{const response=await fetch('/api/slack/link/complete',{method:'POST',signal:AbortSignal.timeout(10000),credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({token:'${token.data}'})});if(!response.ok)throw new Error('Unavailable');status.textContent='Connected. You can return to Slack.';}catch(error){console.warn('Slack link unavailable',error instanceof Error?error.name:'UnknownError');status.textContent='Unable to connect. In Slack, send connect to Matrix for a fresh link and try again.';button.disabled=false;}});</script>`
      : `<a href="/sign-in?redirect_url=${encodeURIComponent(returnPath)}">Sign in to connect</a>`;
    return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect Slack to Matrix</title><style nonce="${nonce}">body{font:18px system-ui;margin:12vh auto;padding:24px;max-width:520px;color:CanvasText;background:Canvas}button,a{font:inherit}button{padding:12px 20px}p{line-height:1.5}</style></head><body><main><h1>Connect Slack to Matrix</h1><p>Link your private Slack conversation to your Matrix account. Your organization membership is verified before connection.</p>${content}</main></body></html>`);
  });
  return app;
}

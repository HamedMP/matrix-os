import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { VoiceCallProvider } from "./providers/base.js";
import type { CallManager } from "./call-manager.js";
import type { WebhookContext } from "./types.js";

export type WebhookRouterConfig = {
  callManager: CallManager;
  providers: Map<string, VoiceCallProvider>;
};

export function createWebhookRouter(config: WebhookRouterConfig): Hono {
  const app = new Hono();

  app.use("/*", bodyLimit({ maxSize: 64 * 1024 }));

  app.post("/:provider", async (c) => {
    const providerName = c.req.param("provider");
    const provider = config.providers.get(providerName);

    if (!provider) {
      return c.json({ error: `Unknown provider: ${providerName}` }, 404);
    }

    const rawBody = await c.req.text();
    const url = c.req.url;
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const webhookCtx: WebhookContext = {
      method: c.req.method as WebhookContext["method"],
      url,
      headers,
      rawBody,
    };

    const verification = provider.verifyWebhook(webhookCtx);
    if (!verification.ok) {
      console.warn(`[webhook] Verification failed for ${providerName}:`, verification.reason);
      return c.json({ error: "Webhook verification failed" }, 403);
    }

    const parseResult = provider.parseWebhookEvent(webhookCtx, {
      verifiedRequestKey: verification.verifiedRequestKey,
    });

    const errors: string[] = [];
    for (const event of parseResult.events) {
      try {
        const providerCallId = event.providerCallId ?? event.callId;
        const internalCallId = config.callManager.getCallIdByProviderCallId(providerCallId);
        if (!internalCallId) {
          console.warn(`[webhook] No internal call found for provider call ${providerCallId}, skipping`);
          continue;
        }
        config.callManager.processEvent(internalCallId, event);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[webhook] Event processing error for call ${event.callId}:`, msg);
        errors.push(msg);
      }
    }

    if (errors.length > 0) {
      return c.json({ ok: false }, 500);
    }

    if (parseResult.providerResponseBody) {
      const responseHeaders = parseResult.providerResponseHeaders ?? {};
      for (const [key, value] of Object.entries(responseHeaders)) {
        c.header(key, value);
      }
      return c.body(parseResult.providerResponseBody, 200);
    }

    return c.json({ ok: true }, 200);
  });

  return app;
}

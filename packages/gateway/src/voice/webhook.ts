import { Hono } from "hono";
import type { VoiceCallProvider } from "./providers/base.js";
import type { CallManager } from "./call-manager.js";
import type { WebhookContext } from "./types.js";

export type WebhookRouterConfig = {
  callManager: CallManager;
  providers: Map<string, VoiceCallProvider>;
};

export function createWebhookRouter(config: WebhookRouterConfig): Hono {
  const app = new Hono();

  app.post("/:provider", async (c) => {
    const providerName = c.req.param("provider");
    const provider = config.providers.get(providerName);

    if (!provider) {
      return c.json({ error: "Not found" }, 404);
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
      return c.json(
        { error: "Webhook verification failed", reason: verification.reason },
        403,
      );
    }

    const parseResult = provider.parseWebhookEvent(webhookCtx, {
      verifiedRequestKey: verification.verifiedRequestKey,
    });

    for (const event of parseResult.events) {
      try {
        config.callManager.processEvent(event.callId, event);
      } catch {
        // Event processing errors are logged but don't fail the webhook
      }
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

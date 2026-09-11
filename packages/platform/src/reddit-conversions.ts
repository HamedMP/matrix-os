import { createHash } from "node:crypto";

const REDDIT_CONVERSIONS_API_ORIGIN = "https://ads-api.reddit.com";
const REDDIT_CONVERSIONS_TIMEOUT_MS = 10_000;
const REDDIT_PIXEL_ID_PATTERN = /^a2_[A-Za-z0-9]+$/;

export interface RedditPurchaseInput {
  eventAt: number;
  checkoutSessionId: string;
  clerkUserId: string;
  clickId?: string;
  eventSourceUrl?: string;
  currency: string;
  value: number;
}

export interface RedditConversionsClient {
  sendPurchase(input: RedditPurchaseInput): Promise<"sent" | "disabled">;
}

export class RedditConversionDeliveryError extends Error {
  constructor() {
    super("Reddit conversion delivery failed");
    this.name = "RedditConversionDeliveryError";
  }
}

export function createRedditConversionsClient(options: {
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
} = {}): RedditConversionsClient {
  const env = options.env ?? process.env;
  const fetcher = options.fetcher ?? fetch;
  const pixelId = env.REDDIT_PIXEL_ID?.trim();
  const accessToken = env.REDDIT_CONVERSIONS_ACCESS_TOKEN?.trim();
  const configured = Boolean(
    pixelId
    && REDDIT_PIXEL_ID_PATTERN.test(pixelId)
    && accessToken,
  );

  return {
    async sendPurchase(input) {
      if (!configured || !pixelId || !accessToken) return "disabled";
      const currency = input.currency.toUpperCase();
      if (
        !Number.isSafeInteger(input.eventAt)
        || input.eventAt <= 0
        || !/^[A-Z]{3}$/.test(currency)
        || !Number.isFinite(input.value)
        || input.value < 0
        || !input.checkoutSessionId
        || !input.clerkUserId
      ) {
        throw new RedditConversionDeliveryError();
      }

      const event = {
        event_at: input.eventAt,
        action_source: "WEBSITE",
        type: { tracking_type: "PURCHASE" },
        ...(input.clickId ? { click_id: input.clickId.slice(0, 256) } : {}),
        ...(validEventSourceUrl(input.eventSourceUrl)
          ? { event_source_url: input.eventSourceUrl }
          : {}),
        user: {
          external_id: sha256(input.clerkUserId),
        },
        metadata: {
          currency,
          value: input.value,
          conversion_id: sha256(input.checkoutSessionId),
        },
      };

      try {
        const response = await fetcher(
          `${REDDIT_CONVERSIONS_API_ORIGIN}/api/v3/pixels/${encodeURIComponent(pixelId)}/conversion_events`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${accessToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ data: { events: [event] } }),
            signal: AbortSignal.timeout(REDDIT_CONVERSIONS_TIMEOUT_MS),
          },
        );
        if (!response.ok) throw new RedditConversionDeliveryError();
        return "sent";
      } catch (err: unknown) {
        if (err instanceof RedditConversionDeliveryError) throw err;
        throw new RedditConversionDeliveryError();
      }
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validEventSourceUrl(value: string | undefined): value is string {
  if (!value || value.length > 1024) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "matrix-os.com";
  } catch {
    return false;
  }
}

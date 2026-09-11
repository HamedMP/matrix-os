import { createHash } from "node:crypto";

const REDDIT_CONVERSIONS_API_ORIGIN = "https://ads-api.reddit.com";
const REDDIT_CONVERSIONS_TIMEOUT_MS = 10_000;
const REDDIT_PIXEL_ID_PATTERN = /^a2_[A-Za-z0-9]+$/;

export interface RedditAttributedEventInput {
  eventAt: number;
  conversionId: string;
  clerkUserId: string;
  clickId?: string;
  eventSourceUrl?: string;
}

export interface RedditPurchaseInput extends RedditAttributedEventInput {
  currency: string;
  value: number;
}

export type RedditSignUpInput = RedditAttributedEventInput;

export interface RedditConversionsClient {
  sendPurchase(input: RedditPurchaseInput): Promise<"sent" | "disabled">;
  sendSignUp(input: RedditSignUpInput): Promise<"sent" | "disabled">;
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

  async function sendConversion(
    trackingType: "PURCHASE" | "SIGN_UP",
    input: RedditPurchaseInput | RedditSignUpInput,
  ): Promise<"sent" | "disabled"> {
    if (!configured || !pixelId || !accessToken) return "disabled";
    if (
      !Number.isSafeInteger(input.eventAt)
      || input.eventAt <= 0
      || !input.conversionId
      || !input.clerkUserId
    ) {
      throw new RedditConversionDeliveryError();
    }

    const purchaseMetadata = trackingType === "PURCHASE"
      ? readPurchaseMetadata(input)
      : undefined;
    if (trackingType === "PURCHASE" && !purchaseMetadata) {
      throw new RedditConversionDeliveryError();
    }

    const event = {
      event_at: input.eventAt,
      action_source: "WEBSITE",
      type: { tracking_type: trackingType },
      ...(input.clickId ? { click_id: input.clickId.slice(0, 256) } : {}),
      ...(validEventSourceUrl(input.eventSourceUrl)
        ? { event_source_url: input.eventSourceUrl }
        : {}),
      user: {
        external_id: sha256(input.clerkUserId),
      },
      metadata: {
        conversion_id: sha256(input.conversionId),
        ...purchaseMetadata,
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
  }

  return {
    sendPurchase(input) {
      return sendConversion("PURCHASE", input);
    },
    sendSignUp(input) {
      return sendConversion("SIGN_UP", input);
    },
  };
}

function readPurchaseMetadata(
  input: RedditPurchaseInput | RedditSignUpInput,
): { currency: string; value: number } | null {
  if (!("currency" in input) || !("value" in input)) return null;
  const currency = input.currency.toUpperCase();
  if (
    !/^[A-Z]{3}$/.test(currency)
    || !Number.isFinite(input.value)
    || input.value <= 0
  ) return null;
  return { currency, value: input.value };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validEventSourceUrl(value: string | undefined): value is string {
  if (!value || value.length > 1024) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "matrix-os.com";
  } catch (err: unknown) {
    if (!(err instanceof TypeError)) return false;
    return false;
  }
}

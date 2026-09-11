import type {
  RedditConversionsClient,
  RedditPurchaseInput,
} from './reddit-conversions.js';

interface StripeEventForRedditAttribution {
  type: string;
  created: number;
  data: { object: unknown };
}

export async function deliverRedditPurchaseAttribution(
  event: StripeEventForRedditAttribution,
  client: RedditConversionsClient | undefined,
): Promise<'sent' | 'disabled' | 'ignored'> {
  if (event.type !== 'checkout.session.completed' || !client) return 'ignored';
  const purchase = readRedditPurchase(event);
  if (!purchase) return 'ignored';
  return client.sendPurchase(purchase);
}

export function isSafeMarketingLandingPath(value: string): boolean {
  if (!value.startsWith('/') || value.startsWith('//')) return false;
  try {
    const url = new URL(value, 'https://matrix-os.com');
    return url.origin === 'https://matrix-os.com';
  } catch (err: unknown) {
    if (!(err instanceof TypeError)) return false;
    return false;
  }
}

function readRedditPurchase(event: StripeEventForRedditAttribution): RedditPurchaseInput | null {
  if (!event.data.object || typeof event.data.object !== 'object') return null;
  const session = event.data.object as {
    id?: unknown;
    client_reference_id?: unknown;
    amount_total?: unknown;
    currency?: unknown;
    metadata?: unknown;
  };
  const checkoutSessionId = readStripeObjectId(session.id);
  const clerkUserId = readClerkUserId(session.client_reference_id, session.metadata);
  if (
    !checkoutSessionId
    || !clerkUserId
    || !Number.isSafeInteger(session.amount_total)
    || (session.amount_total as number) < 0
    || typeof session.currency !== 'string'
    || !/^[a-z]{3}$/.test(session.currency)
    || !Number.isSafeInteger(event.created)
    || event.created <= 0
  ) {
    return null;
  }
  const metadata = readMetadata(session.metadata);
  const clickId = readBoundedString(metadata.matrix_attr_rdt_cid, 256);
  const landingPath = readBoundedString(metadata.matrix_attr_landing_path, 512);
  const sourceUrl = new URL(
    landingPath && isSafeMarketingLandingPath(landingPath) ? landingPath : '/',
    'https://matrix-os.com',
  );
  if (clickId && !sourceUrl.searchParams.has('rdt_cid')) {
    sourceUrl.searchParams.set('rdt_cid', clickId);
  }
  return {
    eventAt: event.created * 1_000,
    checkoutSessionId,
    clerkUserId,
    ...(clickId ? { clickId } : {}),
    eventSourceUrl: sourceUrl.toString(),
    currency: session.currency,
    value: (session.amount_total as number) / 100,
  };
}

function readStripeObjectId(value: unknown): string | null {
  return typeof value === 'string' && /^cs_[A-Za-z0-9_]{1,252}$/.test(value) ? value : null;
}

function readClerkUserId(clientReferenceId: unknown, metadataValue: unknown): string | null {
  const metadata = readMetadata(metadataValue);
  for (const value of [clientReferenceId, metadata.clerk_user_id]) {
    if (typeof value === 'string' && /^user_[A-Za-z0-9]{1,128}$/.test(value)) return value;
  }
  return null;
}

function readMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readBoundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    ? value
    : undefined;
}

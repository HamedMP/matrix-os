import type {
  RedditAttributedEventInput,
  RedditConversionsClient,
  RedditPurchaseInput,
} from './reddit-conversions.js';

interface StripeEventForRedditAttribution {
  type: string;
  created: number;
  data: { object: unknown };
}

export async function deliverRedditAttribution(
  event: StripeEventForRedditAttribution,
  client: RedditConversionsClient | undefined,
): Promise<'sent' | 'disabled' | 'ignored'> {
  if (!client) return 'ignored';
  if (event.type === 'checkout.session.completed') {
    const checkout = readRedditCheckout(event);
    if (!checkout) return 'ignored';
    if (checkout.kind === 'sign_up') return client.sendSignUp(checkout.input);
    return client.sendPurchase(checkout.input);
  }
  if (event.type === 'invoice.paid') {
    const purchase = readRedditInvoicePurchase(event);
    if (!purchase) return 'ignored';
    return client.sendPurchase(purchase);
  }
  return 'ignored';
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

function readRedditCheckout(event: StripeEventForRedditAttribution):
  | { kind: 'sign_up'; input: RedditAttributedEventInput }
  | { kind: 'purchase'; input: RedditPurchaseInput }
  | null {
  if (!event.data.object || typeof event.data.object !== 'object') return null;
  const session = event.data.object as {
    id?: unknown;
    mode?: unknown;
    client_reference_id?: unknown;
    amount_total?: unknown;
    currency?: unknown;
    metadata?: unknown;
  };
  const conversionId = readStripeObjectId(session.id, 'cs');
  const clerkUserId = readClerkUserId(session.client_reference_id, session.metadata);
  if (
    !conversionId
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
  const common = {
    eventAt: event.created * 1_000,
    conversionId,
    clerkUserId,
    ...readAttribution(metadata),
  };
  if (session.mode === 'subscription' && session.amount_total === 0) {
    return { kind: 'sign_up', input: common };
  }
  if (session.mode !== 'payment' || (session.amount_total as number) <= 0) return null;
  return {
    kind: 'purchase',
    input: {
      ...common,
      currency: session.currency,
      value: (session.amount_total as number) / 100,
    },
  };
}

function readRedditInvoicePurchase(
  event: StripeEventForRedditAttribution,
): RedditPurchaseInput | null {
  if (!event.data.object || typeof event.data.object !== 'object') return null;
  const invoice = event.data.object as {
    id?: unknown;
    amount_paid?: unknown;
    currency?: unknown;
    parent?: { subscription_details?: { metadata?: unknown } };
  };
  const conversionId = readStripeObjectId(invoice.id, 'in');
  const metadata = readMetadata(invoice.parent?.subscription_details?.metadata);
  const clerkUserId = readClerkUserId(undefined, metadata);
  if (
    !conversionId
    || !clerkUserId
    || !Number.isSafeInteger(invoice.amount_paid)
    || (invoice.amount_paid as number) <= 0
    || typeof invoice.currency !== 'string'
    || !/^[a-z]{3}$/.test(invoice.currency)
    || !Number.isSafeInteger(event.created)
    || event.created <= 0
  ) return null;
  return {
    eventAt: event.created * 1_000,
    conversionId,
    clerkUserId,
    ...readAttribution(metadata),
    currency: invoice.currency,
    value: (invoice.amount_paid as number) / 100,
  };
}

function readAttribution(metadata: Record<string, unknown>): {
  clickId?: string;
  eventSourceUrl: string;
} {
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
    ...(clickId ? { clickId } : {}),
    eventSourceUrl: sourceUrl.toString(),
  };
}

function readStripeObjectId(value: unknown, prefix: 'cs' | 'in'): string | null {
  return typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_]{1,252}$`).test(value)
    ? value
    : null;
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

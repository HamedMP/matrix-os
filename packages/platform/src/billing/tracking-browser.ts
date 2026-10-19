import type { BillingTrackingEvent } from './tracking-events.js';

// Serialized as a standalone same-origin asset for both Next shell and platform HTML.
// Keep this function closed over no module values; its emitted source is browser JavaScript.
function trackingBrowser(containerId: string) {
  const state = window as Window & {
    __matrixBillingTracking?: boolean;
    dataLayer?: Array<Record<string, unknown> | IArguments>;
    matrixGetGoogleAttribution?: () => Record<string, string | number> | undefined;
  };
  if (state.__matrixBillingTracking || document.documentElement.dataset.matrixSelfHosted === '1') return;
  state.__matrixBillingTracking = true;
  const consentKey = 'matrix_marketing_consent_v1';
  const receiptKey = 'matrix_billing_gtm_receipts_v1';
  const initialUrl = new URL(window.location.href);
  const sessionId = initialUrl.searchParams.get('session_id');
  function cookie(name: string) {
    try {
      const entry = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`));
      return entry ? decodeURIComponent(entry.slice(name.length + 1)) : null;
    } catch (error: unknown) {
      console.warn('[billing] Tracking cookie unavailable:', error instanceof Error ? error.name : typeof error);
      return null;
    }
  }
  function consentChoice(): { choice: string; expiresAt: number } | null {
    try {
      const raw = cookie(consentKey) ?? window.localStorage.getItem(consentKey);
      const value = raw ? JSON.parse(raw) : null;
      return value?.version === 1 && ['accepted', 'rejected'].includes(value.choice)
        && value.expiresAt > Date.now() && value.expiresAt <= Date.now() + 180 * 86400000 ? value : null;
    } catch (error: unknown) {
      console.warn('[billing] Tracking consent unavailable:', error instanceof Error ? error.name : typeof error);
      return null;
    }
  }
  function google() {
    state.dataLayer ??= [];
    state.dataLayer.push(arguments);
  }
  function consentState() {
    const value = consentChoice()?.choice === 'accepted' ? 'granted' : 'denied';
    return { analytics_storage: value, ad_storage: value, ad_user_data: value, ad_personalization: value };
  }
  // Google requires defaults to precede container initialization and measurement.
  (google as (...args: unknown[]) => void)('consent', 'default', consentState());
  (google as (...args: unknown[]) => void)('set', 'ads_data_redaction', true);
  function updateConsent() { (google as (...args: unknown[]) => void)('consent', 'update', consentState()); }
  window.addEventListener('matrix-marketing-consent-changed', updateConsent);
  window.addEventListener('focus', updateConsent);
  window.addEventListener('storage', event => { if (event.key === consentKey || event.key === null) updateConsent(); });
  state.matrixGetGoogleAttribution = () => {
    const choice = consentChoice();
    if (choice?.choice !== 'accepted') return undefined;
    const clientId = cookie('_ga')?.match(/^GA\d+\.\d+\.(\d+\.\d+)$/)?.[1];
    if (!clientId) return undefined;
    return { clientId, analyticsConsent: 'granted', adUserData: 'granted', adPersonalization: 'granted', expiresAt: choice.expiresAt };
  };
  if (/^GTM-[A-Z0-9]+$/.test(containerId) && !document.getElementById('matrix-google-tag-manager')) {
    state.dataLayer!.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
    const script = document.createElement('script');
    script.id = 'matrix-google-tag-manager'; script.async = true;
    script.src = `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(containerId)}`;
    document.head.appendChild(script);
  }
  function emit(event: BillingTrackingEvent) {
    const current = new URL(window.location.href);
    current.searchParams.set('currency', event.ecommerce.currency);
    current.searchParams.set('plan', event.plan);
    current.searchParams.set('interval', event.billing_interval);
    current.searchParams.set('amount', String(event.amount_paid));
    current.searchParams.set('transaction_id', event.ecommerce.transaction_id);
    current.searchParams.set('trial', String(event.event === 'trial_started'));
    // Removing the session token also prevents re-emission on refresh when storage is blocked.
    current.searchParams.delete('session_id');
    window.history.replaceState(window.history.state, '', `${current.pathname}${current.search}${current.hash}`);
    let receipts: string[] = [];
    try {
      const stored: unknown = JSON.parse(window.localStorage.getItem(receiptKey) ?? '[]');
      if (Array.isArray(stored)) receipts = stored.filter((value): value is string => typeof value === 'string').slice(-128);
    } catch (error: unknown) {
      console.warn('[billing] Conversion receipts unavailable:', error instanceof Error ? error.name : typeof error);
    }
    if (receipts.includes(event.event_id)) return;
    try { window.localStorage.setItem(receiptKey, JSON.stringify([...receipts, event.event_id].slice(-128))); }
    catch (error: unknown) { console.warn('[billing] Conversion receipt unavailable:', error instanceof Error ? error.name : typeof error); }
    state.dataLayer!.push({ ecommerce: null });
    state.dataLayer!.push({ ...event, tracking_source: 'browser' });
  }
  async function resolveCheckout() {
    if (!sessionId || !/^cs_(?:test_|live_)?[A-Za-z0-9_]{1,240}$/.test(sessionId)) return;
    for (let attempt = 0; attempt < 15; attempt++) {
      try {
        const response = await fetch(`/billing/checkout-result?session_id=${encodeURIComponent(sessionId)}`, {
          credentials: 'include', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000),
        });
        if (response.status === 404 || response.status === 400) return;
        if (response.ok) {
          const body = await response.json() as { event?: BillingTrackingEvent | null };
          if (body.event && ['purchase', 'trial_started'].includes(body.event.event)) {
            const event = body.event;
            if (navigator.locks) await navigator.locks.request(`matrix-billing-${event.event_id}`, () => emit(event));
            else emit(event);
            return;
          }
        }
      } catch (error: unknown) {
        console.warn('[billing] Checkout measurement pending:', error instanceof Error ? error.name : typeof error);
      }
      await new Promise(resolve => window.setTimeout(resolve, 2000));
    }
  }
  void resolveCheckout();
}

export function billingTrackingScript(containerId: string): string {
  // tsx preserves function names with __name; keep that helper local in the
  // standalone asset as well as supporting ordinary tsc production output.
  return `(function(){const __name=(fn)=>fn;(${trackingBrowser.toString()})(${JSON.stringify(containerId)});})();`;
}

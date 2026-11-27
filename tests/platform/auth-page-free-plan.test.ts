import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { FREE_PLAN_COPY } from '../../packages/contracts/src/free-plan-copy.js';
import { getAuthPage } from '../../packages/platform/src/auth-pages.js';

/**
 * The platform pre-VPS page (spec 2691, ENG-520): an owner the journey offers
 * the Free plan sees free setup copy, not "Build VPS"; everyone else keeps the
 * paid default-installs step unchanged.
 */

interface Recorded { url: string; init: RequestInit | undefined }

async function waitForCondition(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the auth page state');
}

function openAuthPage(options: {
  freePlanAvailable?: boolean;
  journey?: () => Response;
  provision?: () => Response;
  mode?: 'sign-in' | 'sign-up';
  signedIn?: boolean;
}) {
  const requests: Recorded[] = [];
  const html = getAuthPage(
    'pk_test_matrix',
    options.mode ?? 'sign-up',
    'test-nonce',
    '/',
    'https://app.matrix-os.com',
    options.freePlanAvailable === undefined ? undefined : { freePlanAvailable: options.freePlanAvailable },
  );
  const dom = new JSDOM(html, {
    url: 'https://app.matrix-os.com/',
    runScripts: 'dangerously',
    beforeParse(window) {
      Object.assign(window, {
        AbortSignal,
        Response,
        Clerk: {
          load: async () => undefined,
          user: options.signedIn === false ? null : {
            fullName: 'Test User',
            username: 'test-user',
            primaryEmailAddress: { emailAddress: 'test@example.com' },
          },
          session: { getToken: async () => 'clerk-token' },
          signOut: async () => undefined,
          mountSignUp: () => undefined,
          mountSignIn: () => undefined,
        },
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          requests.push({ url, init });
          if (url === '/api/auth/app-session') return Response.json({ code: 'no_runtime' }, { status: 404 });
          if (url === '/api/journey' && options.journey) return options.journey();
          if (url === '/api/auth/provision-runtime' && options.provision) return options.provision();
          return Response.json({}, { status: 503 });
        },
      });
    },
  });
  return { dom, requests };
}

function button(dom: JSDOM, label: string): HTMLButtonElement | undefined {
  return Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>('button'))
    .find((candidate) => candidate.textContent === label);
}

const freeJourney = () => Response.json({
  phase: 'install_choices_required',
  detail: 'Set up your free Matrix computer.',
  nextAction: { kind: 'start_provision' },
});
const paidJourney = () => Response.json({
  phase: 'install_choices_required',
  detail: 'Choose default installs before building your Matrix computer.',
  nextAction: { kind: 'choose_default_installs' },
});

describe('platform pre-VPS page on the Free plan', () => {
  const openDoms: JSDOM[] = [];
  afterEach(() => {
    for (const dom of openDoms.splice(0)) dom.window.close();
  });

  it('shows a free owner free setup, with the preinstalls and the sleep rule, instead of Build VPS', async () => {
    const { dom, requests } = openAuthPage({ freePlanAvailable: true, journey: freeJourney });
    openDoms.push(dom);

    await waitForCondition(() => Boolean(button(dom, FREE_PLAN_COPY.setupLabel)));
    const text = dom.window.document.getElementById('auth')?.textContent ?? '';
    expect(text).not.toContain('VPS');
    expect(text).toContain(FREE_PLAN_COPY.preinstalls);
    expect(text).toContain(FREE_PLAN_COPY.sleep);
    expect(text).toContain('Free plan');
    expect(text).not.toContain('Completed');
    // Free computers take no install choices.
    expect(dom.window.document.querySelectorAll('.developer-tool-option input')).toHaveLength(0);
    const journeyRequest = requests.find((request) => request.url === '/api/journey');
    expect(new Headers(journeyRequest?.init?.headers).get('authorization')).toBe('Bearer clerk-token');
  });

  it('starts free setup without naming tools and explains a full free plan', async () => {
    const { dom, requests } = openAuthPage({
      freePlanAvailable: true,
      journey: freeJourney,
      provision: () => Response.json({ error: 'Free capacity is full', code: 'busy' }, { status: 503 }),
    });
    openDoms.push(dom);

    await waitForCondition(() => Boolean(button(dom, FREE_PLAN_COPY.setupLabel)));
    button(dom, FREE_PLAN_COPY.setupLabel)!.click();

    await waitForCondition(() => (dom.window.document.querySelector('.default-installs-error')?.textContent ?? '') !== '');
    expect(dom.window.document.querySelector('.default-installs-error')?.textContent).toBe(FREE_PLAN_COPY.capacityFull);
    const provision = requests.find((request) => request.url === '/api/auth/provision-runtime');
    expect(JSON.parse(String(provision?.init?.body))).not.toHaveProperty('developerTools');
    expect(button(dom, FREE_PLAN_COPY.setupLabel)?.disabled).toBe(false);
  });

  it('says setup could not start, without VPS, when a free start fails for another reason', async () => {
    const { dom } = openAuthPage({
      freePlanAvailable: true,
      journey: freeJourney,
      provision: () => Response.json({ error: 'Provisioning unavailable', code: 'provisioning_unavailable' }, { status: 503 }),
    });
    openDoms.push(dom);

    await waitForCondition(() => Boolean(button(dom, FREE_PLAN_COPY.setupLabel)));
    button(dom, FREE_PLAN_COPY.setupLabel)!.click();
    await waitForCondition(() => (dom.window.document.querySelector('.default-installs-error')?.textContent ?? '') !== '');
    expect(dom.window.document.querySelector('.default-installs-error')?.textContent).toBe(FREE_PLAN_COPY.setupRetry);
  });

  it.each([
    ['a paid journey', paidJourney],
    ['an unavailable journey', () => Response.json({ error: 'journey_unavailable' }, { status: 503 })],
  ])('keeps the paid Build VPS step for %s', async (_label, journey) => {
    const { dom } = openAuthPage({ freePlanAvailable: true, journey });
    openDoms.push(dom);

    await waitForCondition(() => Boolean(button(dom, 'Build VPS')));
    expect(dom.window.document.querySelectorAll('.developer-tool-option input').length).toBeGreaterThan(0);
  });

  it('does not ask the journey when the Free plan is off', async () => {
    const { dom, requests } = openAuthPage({ journey: freeJourney });
    openDoms.push(dom);

    await waitForCondition(() => Boolean(button(dom, 'Build VPS')));
    expect(requests.some((request) => request.url === '/api/journey')).toBe(false);
  });

  it('describes the Free plan on sign-up only while it is open', () => {
    const open = getAuthPage('pk_test_matrix', 'sign-up', 'nonce', '/', 'https://app.matrix-os.com', { freePlanAvailable: true });
    expect(open).toContain(FREE_PLAN_COPY.signUpLead);
    expect(open).toContain(FREE_PLAN_COPY.summary);
    expect(open).not.toContain('trial');

    const closed = getAuthPage('pk_test_matrix', 'sign-up', 'nonce', '/', 'https://app.matrix-os.com');
    expect(closed).not.toContain(FREE_PLAN_COPY.signUpLead);
    expect(closed).toContain('Choose your cloud computer to see available trial offers and billing details.');
  });
});

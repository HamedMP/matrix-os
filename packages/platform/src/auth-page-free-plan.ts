import { FREE_CAPACITY_FULL_CODE, FREE_PLAN_COPY } from '@matrix-os/contracts/free-plan-copy';
import { escapeHtml } from './html-escaping.js';

/**
 * Free plan pieces of the platform pre-VPS page (spec 2691, ENG-520), kept out
 * of auth-pages.ts. When the Free plan is open, the page asks the journey
 * whether this owner is offered it (`start_provision`) and, if so, shows free
 * setup instead of the paid "Build VPS" step. Paid owners, and any journey
 * failure, keep the paid step unchanged.
 */

export interface AuthPageFreePlanOptions {
  /**
   * The deployment has a free runtime provisioner, so an owner the journey offers
   * the Free plan (invited, or anyone when signup is open) gets free setup.
   * False keeps the page exactly as before.
   */
  freePlanAvailable?: boolean;
  /** Free signup is open to everyone, so the public sign-up hero may promise it. */
  freeSignupOffer?: boolean;
}

const JOURNEY_TIMEOUT_MS = 10_000;

/** Only the strings the setup step uses; the sign-up hero copy stays out of the script. */
const SCRIPT_COPY = {
  preinstalls: FREE_PLAN_COPY.preinstalls,
  sleep: FREE_PLAN_COPY.sleep,
  capacityFull: FREE_PLAN_COPY.capacityFull,
  setupRetry: FREE_PLAN_COPY.setupRetry,
  setupLabel: FREE_PLAN_COPY.setupLabel,
  settingUpLabel: FREE_PLAN_COPY.settingUpLabel,
};

/** JSON safe to place inside an inline script element. */
function inlineScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

/** The sign-up hero for an open Free plan; null keeps the paid hero. */
export function freePlanSignUpStory(mode: 'sign-in' | 'sign-up', options: AuthPageFreePlanOptions): {
  lead: string;
  proofRows: string[];
} | null {
  if (mode !== 'sign-up' || !options.freePlanAvailable || !options.freeSignupOffer) return null;
  return {
    lead: escapeHtml(FREE_PLAN_COPY.signUpLead),
    proofRows: [
      FREE_PLAN_COPY.summary,
      FREE_PLAN_COPY.sleep,
      'Clerk handles account security and the payment step for paid plans.',
    ].map((row) => escapeHtml(row)),
  };
}

/**
 * Inline script: `freePlanAvailable`, `freePlanCopy`, `freePlanToolIds`,
 * `resolveFreePlanSetup()` (resolves true only for a journey offering
 * `start_provision`), and `freeProvisionFailureMessage(res)`.
 */
export function freePlanAuthScript(options: AuthPageFreePlanOptions): string {
  return `
    var freePlanAvailable = ${options.freePlanAvailable ? 'true' : 'false'};
    // Inlined only while the Free plan is open; the paid page never reads it.
    var freePlanCopy = ${options.freePlanAvailable ? inlineScriptJson(SCRIPT_COPY) : 'null'};
    var freeCapacityFullCode = ${inlineScriptJson(FREE_CAPACITY_FULL_CODE)};
    var freePlanToolIds = ['claude-code', 'codex'];
    function resolveFreePlanSetup() {
      if (!freePlanAvailable || !window.Clerk.session) return Promise.resolve(false);
      return window.Clerk.session.getToken()
        .then(function(token) {
          if (!token) return null;
          return fetch('/api/journey', {
            method: 'GET',
            headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
            credentials: 'same-origin',
            signal: AbortSignal.timeout(${JOURNEY_TIMEOUT_MS})
          });
        })
        .then(function(res) { return res && res.ok ? res.json() : null; })
        .then(function(journey) {
          return Boolean(journey && journey.nextAction && journey.nextAction.kind === 'start_provision');
        })
        .catch(function(err) {
          console.warn('[matrix] Free plan check failed', err instanceof Error ? err.name : String(typeof err));
          return false;
        });
    }
    function freeProvisionFailureMessage(res) {
      if (!res || res.status !== 503) return Promise.resolve(freePlanCopy.setupRetry);
      return res.json()
        .then(function(body) {
          return body && body.code === freeCapacityFullCode ? freePlanCopy.capacityFull : freePlanCopy.setupRetry;
        })
        .catch(function(err) {
          console.warn('[matrix] Unable to parse free setup response', err instanceof Error ? err.name : String(typeof err));
          return freePlanCopy.setupRetry;
        });
    }`;
}

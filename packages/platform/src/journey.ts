import { randomUUID } from 'node:crypto';
import {
  appendJourneyEvent,
  getActiveUserMachineByClerkId,
  getSettlingCheckoutAttempt,
  getLatestJourneyEvent,
  getOnboardingFirstRun,
  insertOnboardingFirstRunIfAbsent,
  listRunningMachinesMissingFirstRun,
  type BillingCheckoutAttemptRecord,
  type OnboardingFirstRunRecord,
  type PlatformDB,
  type UserMachineRecord,
} from './db.js';
import { getRuntimeAccessDecision, type BillingEntitlement } from './billing.js';
import { resolveEffectiveBillingEntitlementForSlot } from './billing-entitlement-resolver.js';

export const DEFAULT_SETTLING_WINDOW_MS = 10 * 60 * 1000;

export type JourneyPhase =
  | 'account_required'
  | 'plan_required'
  | 'payment_settling'
  | 'install_choices_required'
  | 'provisioning'
  | 'provisioning_failed'
  | 'first_run'
  | 'ready';

export type JourneyActionKind =
  | 'open_plans'
  | 'wait'
  | 'choose_default_installs'
  | 'start_provision'
  | 'retry_provision'
  | 'contact_support'
  | 'begin_first_run'
  | 'open_shell'
  | 'none';

export type ProvisioningStage = 'creating_server' | 'booting' | 'registering' | 'finalizing';

export interface JourneyReadinessAnnotation {
  status: 'ok' | 'degraded';
  failing: string[];
}

export interface JourneyState {
  phase: JourneyPhase;
  detail: string;
  nextAction: { kind: JourneyActionKind; url?: string };
  progress?: { stage: ProvisioningStage; startedAt: string };
  failure?: { retryable: boolean; attempt: number };
  settling?: { since: string; delayed: boolean };
  readiness?: JourneyReadinessAnnotation;
}

export interface JourneyDerivationInputs {
  entitlement: BillingEntitlement | null;
  /** Newest checkout attempt for the user, if any. */
  checkoutAttempt: BillingCheckoutAttemptRecord | null;
  /** The single non-deleted machine for the user/slot, any status, if any. */
  liveMachine: UserMachineRecord | null;
  firstRun: OnboardingFirstRunRecord | null;
  now: Date;
  settlingWindowMs: number;
  maxProvisionAttempts: number;
  appOrigin: string;
  /** Optional readiness annotation supplied by a caller (Phase C); omitted in Phase B. */
  readiness?: JourneyReadinessAnnotation;
}

function plansUrl(appOrigin: string): string {
  const url = new URL(appOrigin);
  url.searchParams.set('plans', '1');
  return url.toString();
}

function shellUrl(appOrigin: string): string {
  return new URL('/', appOrigin).toString();
}

// An entitlement is "pre-activation" when the user has never reached an
// access-granting state: no row at all, or a Stripe status that precedes
// activation. A lapsed entitlement (was active, now canceled/ended/unpaid/past
// grace) is NOT pre-activation and must route to plan_required so a churned
// subscriber is never trapped in payment_settling.
function isPreActivationEntitlement(entitlement: BillingEntitlement | null): boolean {
  if (!entitlement) return true;
  return entitlement.status === 'incomplete' || entitlement.status === 'none';
}

function deriveProvisioningStage(machine: UserMachineRecord): ProvisioningStage {
  if (machine.status === 'recovering') return 'finalizing';
  if (!machine.hetznerServerId) return 'creating_server';
  if (!machine.publicIPv4) return 'booting';
  return 'registering';
}

/**
 * Pure journey-phase derivation (spec 092 R1/R3). Assumes the caller has already
 * authenticated the user; `account_required` is therefore never emitted here.
 * No I/O — all inputs are pre-fetched so this is exhaustively unit-testable.
 */
export function deriveJourneyPhase(inputs: JourneyDerivationInputs): JourneyState {
  const { entitlement, checkoutAttempt, liveMachine, firstRun, now, settlingWindowMs, maxProvisionAttempts, appOrigin } = inputs;
  const access = getRuntimeAccessDecision(entitlement, now);

  if (!access.runtimeProxyAllowed) {
    // Billing branch. Settling only applies pre-activation; a lapsed entitlement
    // falls straight through to plan_required.
    if (isPreActivationEntitlement(entitlement) && checkoutAttempt) {
      const ageMs = now.getTime() - new Date(checkoutAttempt.createdAt).getTime();
      const withinWindow = ageMs <= settlingWindowMs;
      const sustainsSettling =
        checkoutAttempt.status === 'paid' || (checkoutAttempt.status === 'open' && withinWindow);
      if (sustainsSettling) {
        const delayed = ageMs > settlingWindowMs; // only reachable for a `paid` attempt
        return {
          phase: 'payment_settling',
          detail: delayed
            ? 'Your payment is taking longer than expected to confirm.'
            : 'Activating your subscription…',
          nextAction: delayed ? { kind: 'contact_support' } : { kind: 'wait' },
          settling: { since: checkoutAttempt.createdAt, delayed },
        };
      }
    }
    return {
      phase: 'plan_required',
      detail: 'Choose a plan to create your Matrix computer.',
      nextAction: { kind: 'open_plans', url: plansUrl(appOrigin) },
    };
  }

  // Entitled branch.
  if (!liveMachine) {
    return {
      phase: 'install_choices_required',
      detail: 'Choose default installs before building your Matrix computer.',
      nextAction: { kind: 'choose_default_installs' },
    };
  }

  switch (liveMachine.status) {
    case 'provisioning':
    case 'recovering':
      return {
        phase: 'provisioning',
        detail: 'Building your Matrix computer…',
        nextAction: { kind: 'wait' },
        progress: { stage: deriveProvisioningStage(liveMachine), startedAt: liveMachine.provisionedAt },
      };
    case 'failed': {
      const retryable = liveMachine.attempt < maxProvisionAttempts;
      return {
        phase: 'provisioning_failed',
        detail: retryable
          ? 'Setting up your computer ran into a problem.'
          : 'We could not set up your computer after several attempts.',
        nextAction: retryable ? { kind: 'retry_provision' } : { kind: 'contact_support' },
        failure: { retryable, attempt: liveMachine.attempt },
      };
    }
    case 'running':
      if (!firstRun) {
        return {
          phase: 'first_run',
          detail: 'Finish setting up your Matrix computer.',
          nextAction: { kind: 'begin_first_run' },
        };
      }
      return {
        phase: 'ready',
        detail: 'Your Matrix computer is ready.',
        nextAction: { kind: 'open_shell', url: shellUrl(appOrigin) },
        ...(inputs.readiness ? { readiness: inputs.readiness } : {}),
      };
    default:
      // Unknown/terminal status (e.g. deleted shouldn't appear here): treat as start.
      return {
        phase: 'provisioning',
        detail: 'Ready to build your Matrix computer.',
        nextAction: { kind: 'start_provision' },
      };
  }
}

export interface LoadJourneyDeps {
  db: PlatformDB;
  now?: () => Date;
  settlingWindowMs?: number;
  maxProvisionAttempts: number;
  appOrigin: string;
  env?: NodeJS.ProcessEnv;
  runtimeSlot?: string;
  readiness?: JourneyReadinessAnnotation;
  /** Records a telemetry event when the phase changes. Defaults to true. */
  recordTransition?: boolean;
}

/**
 * Fetches the inputs for a user and derives their journey state. Records a
 * journey-transition telemetry event (best-effort, write-behind) when the
 * computed phase differs from the last recorded one. Performs no provider calls.
 */
export async function loadJourney(clerkUserId: string, deps: LoadJourneyDeps): Promise<JourneyState> {
  const now = (deps.now ?? (() => new Date()))();
  const [entitlement, checkoutAttempt, liveMachine, firstRun] = await Promise.all([
    resolveEffectiveBillingEntitlementForSlot(deps.db, clerkUserId, now, deps.runtimeSlot, deps.env),
    getSettlingCheckoutAttempt(deps.db, clerkUserId, deps.runtimeSlot),
    getActiveUserMachineByClerkId(deps.db, clerkUserId, deps.runtimeSlot),
    getOnboardingFirstRun(deps.db, clerkUserId),
  ]);

  const state = deriveJourneyPhase({
    entitlement,
    checkoutAttempt: checkoutAttempt ?? null,
    liveMachine: liveMachine ?? null,
    firstRun: firstRun ?? null,
    now,
    settlingWindowMs: deps.settlingWindowMs ?? DEFAULT_SETTLING_WINDOW_MS,
    maxProvisionAttempts: deps.maxProvisionAttempts,
    appOrigin: deps.appOrigin,
    readiness: deps.readiness,
  });

  if (deps.recordTransition !== false) {
    await recordJourneyTransition(deps.db, clerkUserId, state, now).catch((err: unknown) => {
      // Telemetry is non-authoritative: never fail the read on a write error.
      console.warn('[journey] transition record failed:', err instanceof Error ? err.name : typeof err);
    });
  }

  return state;
}

export interface FirstRunProbeResult {
  completedAt: string;
  goal?: string | null;
}

/**
 * Backfills server-owned first-run records for legacy users — those whose
 * machine predates the write-behind path. Runs OFF the journey read path (the
 * reconciler calls it): the read path never probes a VPS, so it stays fast and
 * never hangs. `probe` returns a result for a completed onboarding, null for
 * not-completed-or-unreachable; unreachable machines simply retry next pass.
 * Persists with DO NOTHING so it can never clobber an authoritative write-behind.
 */
export async function backfillFirstRunRecords(
  db: PlatformDB,
  opts: { probe: (machine: UserMachineRecord) => Promise<FirstRunProbeResult | null>; limit?: number },
): Promise<{ checked: number; filled: number }> {
  const machines = await listRunningMachinesMissingFirstRun(db, opts.limit ?? 25);
  let filled = 0;
  for (const machine of machines) {
    let result: FirstRunProbeResult | null;
    try {
      result = await opts.probe(machine);
    } catch (err: unknown) {
      // Unreachable / transient probe failure — log so systematic failures are
      // visible, then skip and retry on a later reconciler pass.
      console.warn(
        `[journey] first-run backfill probe failed machine=${machine.machineId}`,
        err instanceof Error ? err.name : typeof err,
      );
      continue;
    }
    if (!result) continue;
    await insertOnboardingFirstRunIfAbsent(db, {
      clerkUserId: machine.clerkUserId,
      completedAt: result.completedAt,
      goal: result.goal ?? null,
      source: 'backfill',
    });
    filled += 1;
  }
  return { checked: machines.length, filled };
}

/** Appends a journey event only when the phase differs from the latest recorded one. */
export async function recordJourneyTransition(
  db: PlatformDB,
  clerkUserId: string,
  state: JourneyState,
  now: Date,
): Promise<void> {
  const last = await getLatestJourneyEvent(db, clerkUserId);
  if (last && last.toPhase === state.phase) return;
  await appendJourneyEvent(db, {
    id: randomUUID(),
    clerkUserId,
    fromPhase: last?.toPhase ?? null,
    toPhase: state.phase,
    detail: state.settling?.delayed ? 'confirmation_delayed' : state.failure ? `attempt_${state.failure.attempt}` : null,
    at: now.toISOString(),
  });
}

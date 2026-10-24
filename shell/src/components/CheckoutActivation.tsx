"use client";

import { AlertCircleIcon, Loader2Icon, RefreshCwIcon } from '@/lib/hugeicons';
import type { JourneyState } from '@/hooks/useJourney';

/** Payment recovery stays separate from purchase controls: never start a second checkout. */
export function CheckoutActivation({ state, checking, onCheckAgain }: {
  state: JourneyState;
  checking: boolean;
  onCheckAgain: () => void;
}) {
  const delayed = state.settling?.delayed;
  return <>
    {delayed
      ? <AlertCircleIcon className="size-6 text-ember" aria-hidden="true" />
      : <Loader2Icon className="size-5 animate-spin text-ember" aria-hidden="true" />}
    <h1 className="text-lg font-medium text-forest">
      {delayed ? 'Taking longer than expected' : 'Activating your subscription'}
    </h1>
    <p className="max-w-sm text-sm">{state.detail}</p>
    <button type="button" onClick={onCheckAgain} disabled={checking}
      className="inline-flex items-center gap-2 rounded-md border border-forest/20 px-3 py-1.5 text-sm hover:bg-forest/5 disabled:opacity-60">
      <RefreshCwIcon className="size-4" aria-hidden="true" />
      {checking ? 'Checking…' : 'Check again'}
    </button>
    {delayed ? <a href="mailto:support@matrix-os.com" className="text-sm underline">Contact support</a> : null}
  </>;
}

"use client";

import { SignIn, useAuth } from '@clerk/nextjs';
import { palette } from '@matrix-os/brand';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { AuthLayout } from './AuthLayout';
import { finishSlackOAuth, readSlackOAuthQuery, type SlackOAuthResult } from '@/lib/slack-oauth-completion';

const messages: Record<SlackOAuthResult, string> = {
  connected: 'Matrix is connected to Slack. You can return to your workspace.',
  signed_out: 'Sign in to the Matrix account that started this installation.',
  forbidden: 'Use the Matrix administrator account that started this installation.',
  expired: 'This installation link has expired or already been used. Start a fresh installation from Matrix.',
  unavailable: 'Unable to finish installation. Start a fresh installation from Matrix and try again.',
};

export function SlackOAuthCompletion() {
  const params = useSearchParams();
  const query = readSlackOAuthQuery(params.toString());
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const [result, setResult] = useState<SlackOAuthResult | null>(null);
  const [busy, setBusy] = useState(false);
  const returnPath = '/slack/oauth/complete?' + params.toString();
  const finish = async () => {
    if (!query || busy) return;
    setBusy(true);
    try { setResult(await finishSlackOAuth(query, getToken)); }
    finally { setBusy(false); }
  };
  return <AuthLayout featureContent={<div className="space-y-5">
    <p className="text-sm font-semibold uppercase tracking-widest" style={{ color: palette.ember }}>Slack + Matrix</p>
    <h1 className="text-4xl font-semibold">Finish connecting Slack.</h1>
    <p className="max-w-lg leading-7" style={{ color: palette.subtle }}>Confirm the Matrix account you used to start installation. Your organization administrator access is verified before Slack connects.</p>
  </div>} formContent={<div className="space-y-5">
    {!query ? <p role="alert">This installation link is invalid. Start a fresh installation from Matrix.</p>
      : !isLoaded ? <p role="status">Checking your Matrix account…</p>
      : !isSignedIn ? <SignIn routing="hash" forceRedirectUrl={returnPath} fallbackRedirectUrl={returnPath} />
      : <><p role="status">{result ? messages[result] : 'Your Matrix account is signed in.'}</p>
        {!result && <button type="button" onClick={finish} disabled={busy} className="w-full rounded-xl px-5 py-3 font-semibold disabled:opacity-60"
          style={{ backgroundColor: palette.deep, color: palette.card }}>{busy ? 'Connecting…' : 'Finish installation'}</button>}</>}
  </div>} />;
}

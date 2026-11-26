"use client";

import { SignIn, useAuth } from '@clerk/nextjs';
import { palette } from '@matrix-os/brand';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { SlackDevOAuthBrowserConfig } from '@matrix-os/contracts/slack-bridge';
import { AuthLayout } from './AuthLayout';
import { finishSlackOAuth, readSlackOAuthQuery, type SlackOAuthResult } from '@/lib/slack-oauth-completion';
import { finishSlackDevOAuth, loadSlackDevOAuthConfig, readSlackDevOAuthLocation, startSlackDevOAuth } from '@/lib/slack-dev-oauth';
import { consumeSlackDevOAuthHandoff, slackDevOAuthHandle } from '@/lib/slack-dev-oauth-privacy';

const messages: Record<SlackOAuthResult, string> = {
  connected: 'Matrix is connected to Slack. You can return to your workspace.',
  signed_out: 'Sign in to the Matrix account that started this installation.',
  forbidden: 'Use the Matrix administrator account that started this installation.',
  expired: 'This installation link has expired or already been used. Start a fresh installation from Matrix.',
  unavailable: 'Unable to finish installation. Start a fresh installation from Matrix and try again.',
};

function SlackDevOAuth({ handle, handoff }: { handle: string; handoff: ReturnType<typeof readSlackDevOAuthLocation> }) {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const [config, setConfig] = useState<SlackDevOAuthBrowserConfig | null | undefined>(undefined);
  const [result, setResult] = useState<SlackOAuthResult | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    let active = true;
    void loadSlackDevOAuthConfig(handle).then(target => {
      if (active) setConfig(target);
    });
    return () => { active = false; };
  }, [handle, isLoaded, isSignedIn]);

  const ticket = handoff?.ticket;
  const completing = ticket && result !== 'expired';
  const submit = async () => {
    if (pending.current || !config || !isLoaded || !isSignedIn) return;
    pending.current = true;
    setBusy(true);
    try {
      if (completing) {
        setResult(await finishSlackDevOAuth(config, ticket, getToken));
        return;
      }
      const start = await startSlackDevOAuth(config, getToken);
      if ('authorizationUrl' in start) window.location.assign(start.authorizationUrl);
      else setResult(start.status);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  if (!isLoaded || (isSignedIn && config === undefined)) return <p role="status">Checking your Dev Slack setup…</p>;
  if (!isSignedIn) return <p role="alert">Sign in to your Matrix account, then reopen this Dev setup page.</p>;
  if (!config) return <p role="alert">Slack installation is unavailable on this computer.</p>;
  const status = result ? messages[result] : handoff?.error === 'cancelled' ? 'Slack authorization was cancelled.'
    : !handoff || handoff.error === 'invalid' ? 'This installation return is invalid. Start a fresh installation.'
    : ticket ? 'Confirm the account that started installation.' : 'Authorize read-only Slack access for this Dev computer.';
  return <div className="ph-no-capture space-y-5">
    <p role="status">{status}</p>
    {result !== 'connected' && <button type="button" onClick={submit} disabled={busy}
      className="w-full rounded-xl px-5 py-3 font-semibold disabled:opacity-60"
      style={{ backgroundColor: palette.deep, color: palette.card }}>
      {busy ? 'Connecting…' : completing ? 'Finish installation' : 'Connect Slack (read-only)'}
    </button>}
  </div>;
}

export function SlackOAuthCompletion() {
  const params = useSearchParams();
  const query = readSlackOAuthQuery(params.toString());
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const [result, setResult] = useState<SlackOAuthResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [devPage, setDevPage] = useState<{ handle: string; handoff: ReturnType<typeof readSlackDevOAuthLocation> } | null>();
  const checkedPage = useRef(false);
  useEffect(() => {
    if (checkedPage.current) return;
    checkedPage.current = true;
    const handle = slackDevOAuthHandle(window.location);
    setDevPage(handle ? { handle, handoff: readSlackDevOAuthLocation(consumeSlackDevOAuthHandoff()) } : null);
  }, []);
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
    {devPage === undefined ? <p role="status">Loading Slack connection…</p>
      : devPage ? <SlackDevOAuth {...devPage} />
      : !query ? <p role="alert">This installation link is invalid. Start a fresh installation from Matrix.</p>
      : !isLoaded ? <p role="status">Checking your Matrix account…</p>
      : !isSignedIn ? <SignIn routing="hash" forceRedirectUrl={returnPath} fallbackRedirectUrl={returnPath} />
      : <><p role="status">{result ? messages[result] : 'Your Matrix account is signed in.'}</p>
        {!result && <button type="button" onClick={finish} disabled={busy} className="w-full rounded-xl px-5 py-3 font-semibold disabled:opacity-60"
          style={{ backgroundColor: palette.deep, color: palette.card }}>{busy ? 'Connecting…' : 'Finish installation'}</button>}</>}
  </div>} />;
}

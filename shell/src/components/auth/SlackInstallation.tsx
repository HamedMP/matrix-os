"use client";
import { OrganizationSwitcher, SignIn, useAuth, useOrganization } from '@clerk/nextjs';
import { palette } from '@matrix-os/brand';
import { AddToSlack } from '@matrix-os/ui/messaging';
import { useEffect, useRef, useState } from 'react';
import { SLACK_INSTALL_PATH } from '@matrix-os/contracts/slack-bridge';
import { startSlackInstallation, type SlackInstallResult } from '@/lib/slack-install';
import { AuthLayout } from './AuthLayout';

const messages: Record<Exclude<SlackInstallResult['status'],'ready'>,string>={
  organization_required:'Choose the Matrix organization you want to connect to Slack.',
  signed_out:'Your sign-in expired. Sign in again before installing.',
  forbidden:'Ask a Matrix organization administrator to install the app, or choose an organization you administer.',
  unavailable:'Unable to start installation. Please try again in a moment.',
};
export function SlackInstallation() {
  const {isLoaded,isSignedIn,userId,sessionId,getToken}=useAuth();
  const {isLoaded:organizationLoaded,organization}=useOrganization();
  const [busy,setBusy]=useState(false);
  const [result,setResult]=useState<SlackInstallResult | null>(null);
  const identity=[userId,sessionId,organization?.id,isSignedIn].join(':');
  const currentIdentity=useRef(identity);
  const currentAttempt=useRef(0);
  useEffect(()=>{currentIdentity.current=identity;setResult(null);currentAttempt.current+=1;setBusy(false);},[identity]);
  useEffect(()=>()=>{currentAttempt.current+=1;},[]);
  const install=async()=>{
    if(busy || !organization) return;
    const selectedOrganization=organization.id;
    const attempt=++currentAttempt.current;
    setBusy(true);setResult(null);
    const next=await startSlackInstallation(selectedOrganization,window.location.origin,getToken);
    if(attempt!==currentAttempt.current || currentIdentity.current!==identity) return;
    setBusy(false);
    if(next.status==='ready') {window.location.assign(next.url);return;}
    setResult(next);
  };
  return <AuthLayout featureContent={<div className="space-y-5">
    <p className="text-sm font-semibold uppercase tracking-widest" style={{color:palette.ember}}>Slack + Matrix</p>
    <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Your Matrix.<br />Now in Slack.</h1>
    <p className="max-w-lg leading-7" style={{color:palette.subtle}}>Bring your personal assistant and your team’s shared knowledge into the conversations you already have.</p>
    <ol className="space-y-3 text-sm leading-6" style={{color:palette.subtle}}>
      <li>1. Sign in and choose your Matrix organization.</li>
      <li>2. Add Matrix to your Slack workspace.</li>
      <li>3. Send <strong>connect</strong> to Matrix in Slack to link your own assistant.</li>
    </ol>
  </div>} formContent={<div className="space-y-5">
    {!isLoaded ? <p role="status">Checking your Matrix account…</p> : !isSignedIn ? <SignIn routing="hash" forceRedirectUrl={SLACK_INSTALL_PATH} fallbackRedirectUrl={SLACK_INSTALL_PATH} />
      : !organizationLoaded ? <p role="status">Loading your organizations…</p>
      : <><h2 className="text-xl font-semibold">Connect your workspace</h2>
        <p className="text-sm leading-6" style={{color:palette.subtle}}>Choose the organization whose administrator account will manage this connection.</p>
        <OrganizationSwitcher hidePersonal afterSelectOrganizationUrl={SLACK_INSTALL_PATH} afterCreateOrganizationUrl={SLACK_INSTALL_PATH} />
        <p className="text-sm">{organization ? organization.name : messages.organization_required}</p>
        {result && result.status!=='ready' && <p role="alert" className="text-sm leading-6">{messages[result.status]}</p>}
        <AddToSlack onClick={()=>void install()} busy={busy} disabled={!organization} />
        <p className="text-xs leading-5" style={{color:palette.subtle}}>Installation needs Matrix organization administrator access and permission to add apps to your Slack workspace. Installing does not connect everyone’s personal account.</p>
      </>}
  </div>} />;
}

import type { Metadata } from 'next';
import { connection } from 'next/server';
import { Suspense } from 'react';
import { SlackOAuthCompletion } from '@/components/auth/SlackOAuthCompletion';
import { SelfHostedUnavailable } from '@/components/auth/SelfHostedUnavailable';

export const metadata: Metadata = { title: 'Connect Slack | Matrix OS', referrer: 'no-referrer', robots: { index: false, follow: false } };
export default async function SlackOAuthCompletionPage() {
  // MATRIX_SELF_HOSTED is a runtime host setting; render per request so neither
  // this check nor the root layout's Clerk choice is frozen at build time.
  await connection();
  // Slack installation is platform-owned; self-hosted documents have no Clerk session to confirm.
  if (process.env.MATRIX_SELF_HOSTED === '1') return <SelfHostedUnavailable feature="Slack installation" />;
  return <Suspense fallback={<p role="status">Loading Slack connection…</p>}><SlackOAuthCompletion /></Suspense>;
}

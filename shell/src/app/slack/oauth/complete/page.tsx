import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SlackOAuthCompletion } from '@/components/auth/SlackOAuthCompletion';

export const metadata: Metadata = { title: 'Connect Slack | Matrix OS', referrer: 'no-referrer', robots: { index: false, follow: false } };
export default function SlackOAuthCompletionPage() {
  return <Suspense fallback={<p role="status">Loading Slack connection…</p>}><SlackOAuthCompletion /></Suspense>;
}

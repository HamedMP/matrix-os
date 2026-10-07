"use client";
import { Dialog } from "../Dialog.js";
import { GMAIL_CONNECTION_METHOD_LABELS } from "@matrix-os/contracts/integration-marketplace";
import type { useGmailConnectionChoice } from "./use-gmail-connection-choice.js";

export function GmailConnectionChoice({ choice }: { choice: ReturnType<typeof useGmailConnectionChoice> }) {
  return <Dialog open={choice.open} onClose={choice.cancel} aria-label="Connect Gmail" className="border shadow-xl"
    style={{ background: "var(--bg-surface, var(--background))", color: "var(--text-primary, var(--foreground))", borderColor: "var(--border-subtle, var(--border))" }}>
    <h2 className="text-lg font-medium">Connect Gmail</h2>
    <p className="mt-2 text-sm">Choose how to connect this account. You can keep separate accounts for each method.</p>
    <div className="mt-5 flex flex-col gap-3">
      {choice.loading ? <p role="status">Loading Gmail connection options…</p> : choice.error ? <>
        <p role="alert">Could not load Gmail connection options. Try again.</p>
        <button type="button" className="rounded-full border px-4 py-2 text-sm" onClick={() => void choice.retry()}>Retry</button>
      </> : choice.options?.methods.map(method => <button key={method} type="button" className="rounded-full border px-4 py-2 text-sm focus-visible:outline-2" onClick={() => choice.choose(method)}>{GMAIL_CONNECTION_METHOD_LABELS[method]}</button>)}
      <button type="button" className="rounded-full px-4 py-2 text-sm" onClick={choice.cancel}>Cancel</button>
    </div>
  </Dialog>;
}

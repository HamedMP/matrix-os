import { useState } from "react";
import type { ChatCredentialOccurrence } from "../../lib/canonical-chat-client";

const REDACTED_CREDENTIAL_MARKER = /\[redacted(?: credential)?\]/g;

export function ChatCredentialDisclosure({
  messageId,
  markdown,
  occurrences,
  values,
  unavailableIds = [],
  loaded,
  enabled = true,
  onReveal,
  onHide,
}: {
  messageId: string;
  markdown: string;
  occurrences: readonly ChatCredentialOccurrence[];
  values: Readonly<Record<string, string>>;
  unavailableIds?: readonly string[];
  loaded: boolean;
  enabled?: boolean;
  onReveal: (id: string) => Promise<unknown>;
  onHide: (id: string) => Promise<unknown>;
}) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  if (!enabled) return null;
  const markerCount = [...markdown.matchAll(REDACTED_CREDENTIAL_MARKER)].length;
  if (markerCount === 0 && occurrences.length === 0) return null;

  const act = async (id: string, operation: (id: string) => Promise<unknown>) => {
    if (pendingId) return;
    setPendingId(id);
    setFailedId(null);
    try {
      await operation(id);
    } catch {
      // The gateway returns uniformly safe errors. Do not print the response,
      // because a future regression could include the credential itself.
      setFailedId(id);
    } finally {
      setPendingId(null);
    }
  };

  const ordered = [...occurrences].sort((left, right) => left.offset - right.offset || left.id.localeCompare(right.id));
  return (
    <div className="mt-2 space-y-2 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}
      role="group" aria-label={`Credentials in message ${messageId}`}>
      {!loaded && ordered.length === 0 ? <p role="status">Checking credential availability…</p> : null}
      {ordered.map((occurrence, index) => {
        const number = index + 1;
        const value = occurrence.revealed ? values[occurrence.id] : undefined;
        return <div key={occurrence.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span>Credential {number}</span>
          {value === undefined && !occurrence.revealed ? (
            <button type="button" aria-label={`Reveal credential ${number}`} disabled={pendingId !== null || occurrence.revealed}
              className="rounded-md border px-2 py-1 font-medium hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50"
              style={{ borderColor: "var(--border-default)" }}
              onClick={() => void act(occurrence.id, onReveal)}>
              Reveal
            </button>
          ) : <>
            {value === undefined ? (
              <span role="status">{unavailableIds.includes(occurrence.id) || failedId === occurrence.id ? "Credential unavailable" : "Loading credential…"}</span>
            ) : (
              <code className="min-w-0 max-w-full break-all rounded px-1 py-0.5" style={{ background: "var(--bg-sunken)", color: "var(--text-primary)" }}>{value}</code>
            )}
            <button type="button" aria-label={`Hide credential ${number}`} disabled={pendingId !== null}
              className="rounded-md border px-2 py-1 font-medium hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50"
              style={{ borderColor: "var(--border-default)" }}
              onClick={() => void act(occurrence.id, onHide)}>Hide</button>
          </>}
          {failedId === occurrence.id ? <span role="alert">The action failed. Try again.</span> : null}
        </div>;
      })}
      {loaded && markerCount > ordered.length ? (
        <p>Some redacted credentials cannot be revealed. Previously redacted values cannot be recovered.</p>
      ) : null}
    </div>
  );
}

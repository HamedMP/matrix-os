import { useState } from "react";
import type { ChatCredentialOccurrence } from "../../lib/canonical-chat-client";

/** This control replaces only its own masked marker in the rendered reply. */
export function ChatCredentialDisclosure({
  marker,
  number,
  occurrence,
  value,
  loaded,
  availabilityFailed = false,
  onReveal,
  onHide,
}: {
  marker: string;
  number: number;
  occurrence?: ChatCredentialOccurrence;
  value?: string;
  loaded: boolean;
  availabilityFailed?: boolean;
  onReveal: (id: string) => Promise<unknown>;
  onHide: (id: string) => Promise<unknown>;
}) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!occurrence) {
    const explanation = !loaded ? "Checking credential availability…"
      : availabilityFailed ? "Credential availability is temporarily unavailable."
        : "Previously redacted values cannot be recovered.";
    return <span title={explanation} aria-label={loaded ? explanation : undefined}>{marker}</span>;
  }

  const revealed = occurrence.revealed;
  const act = async () => {
    if (pending) return;
    setPending(true);
    setFailed(false);
    try {
      await (revealed ? onHide(occurrence.id) : onReveal(occurrence.id));
    } catch {
      // Never render a raw gateway error; a future regression could echo a secret.
      setFailed(true);
    } finally {
      setPending(false);
    }
  };
  return <>
    <button type="button" disabled={pending} data-chat-credential-marker={marker}
      aria-label={`${revealed ? "Hide" : "Reveal"} credential ${number}`}
      title={revealed ? "Hide credential" : "Reveal credential"}
      className="inline max-w-full cursor-pointer break-all rounded px-0.5 font-mono text-[0.9em] underline decoration-dotted underline-offset-2 hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:cursor-wait disabled:opacity-50"
      style={{ color: "var(--text-primary)" }}
      onClick={() => void act()}>
      {revealed && value !== undefined ? value : marker}
    </button>
    {revealed && value === undefined ? <span role="status" className="ml-1 text-xs" title="The value could not be loaded. Click to hide it.">Credential unavailable</span> : null}
    {failed ? <span role="alert" className="ml-1 text-xs">The action failed. Try again.</span> : null}
  </>;
}

import { ConnectionMethodCard } from "./ConnectionMethodCard.js";
import { useState } from "react";
import type { ProviderHarnessInstance } from "@matrix-os/contracts";

/** Older or restricted runtimes keep a visible, explicit supported handoff. */
export function ConnectionFallback({ harness, disabled, onSetupHarness, workflowPermission = "unknown" }: {
  harness: ProviderHarnessInstance;
  disabled: boolean;
  workflowPermission?: "unknown" | "available" | "forbidden";
  onSetupHarness?: (kind: ProviderHarnessInstance["harness"]) => Promise<boolean>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  if (harness.authState === "authenticated" || harness.installState !== "installed") return null;
  const subscription = harness.harness === "codex" ? "ChatGPT" : harness.harness === "claude" ? "Claude" : null;
  const connect = async () => {
    setPending(true);
    setError(false);
    try { if (await onSetupHarness?.(harness.harness) === false) setError(true); }
    catch (caught) { console.warn("[provider-settings] Terminal connection failed:", caught instanceof Error ? caught.name : typeof caught); setError(true); }
    finally { setPending(false); }
  };
  return <section className="matrix-ap-workflow" aria-label={`${harness.displayName} connection`}>
    <h3>Connect {harness.displayName} with</h3>
    {subscription ? <div className="matrix-ap-connection-options">
      <ConnectionMethodCard method="account" title={`${subscription} account`} recommended description={`Use your ${subscription} plan`} disabled={disabled || pending || !onSetupHarness} onClick={() => void connect()} />
      <ConnectionMethodCard method="key" title="API key" description={`Pay ${harness.harness === "codex" ? "OpenAI" : "Anthropic"} per request`} disabled tooltip="Guided key setup is unavailable on this computer" />
    </div> : <button type="button" className="matrix-ap-button" disabled={disabled || pending || !onSetupHarness} onClick={() => void connect()}>Connect {harness.displayName} in Terminal</button>}
    <p className="matrix-ap-help" role="status">{pending ? "Opening Terminal…" : workflowPermission === "forbidden" ? "Only this computer’s owner can manage guided connections." : "Sign-in continues in Terminal. Guided connection is unavailable for this session."}</p>
    {error ? <p className="matrix-ap-help" role="alert">Could not open sign-in. Try again.</p> : null}
  </section>;
}

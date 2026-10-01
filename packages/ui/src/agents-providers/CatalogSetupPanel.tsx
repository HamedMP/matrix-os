import { useState } from "react";
import type { ProviderSettingsSnapshot, ProviderHarnessKind } from "@matrix-os/contracts";

export function CatalogSetupPanel({ entry, disabled, onSetupHarness, onRefresh }: {
  entry: ProviderSettingsSnapshot["harnessCatalog"][number];
  disabled: boolean;
  onSetupHarness?: (kind: ProviderHarnessKind) => Promise<boolean>;
  onRefresh: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState(false);
  const [opened, setOpened] = useState(false);
  const setup = async () => {
    setPending(true); setFailure(false);
    try { if (await onSetupHarness?.(entry.harness)) setOpened(true); else setFailure(true); }
    catch (caught) { console.warn("[provider-settings] Catalog setup failed:", caught instanceof Error ? caught.name : typeof caught); setFailure(true); }
    finally { setPending(false); }
  };
  return <section className="matrix-ap-workflow" aria-label={`${entry.displayName} setup`}>
    <p className="matrix-ap-help">{!entry.available ? "This agent is unavailable on this computer." : entry.installState === "missing" ? "Not on this computer yet. Install it to get started." : "Finish setup in Terminal to connect this agent."}</p>
    {entry.available && entry.setupAction !== "none" ? <button type="button" className="matrix-ap-button matrix-ap-button-primary" disabled={disabled || pending || !onSetupHarness} onClick={() => void setup()}>{pending ? "Opening Terminal…" : entry.setupAction === "install" ? "Install in Terminal" : "Connect in Terminal"}</button> : null}
    {opened ? <p className="matrix-ap-help" role="status">Terminal is open. Finish setup there, then check again.</p> : null}
    {failure ? <p className="matrix-ap-help" role="alert">Setup could not open. Try again.</p> : null}
    {opened ? <button type="button" className="matrix-ap-button" disabled={disabled || pending} onClick={onRefresh}>Check again</button> : null}
  </section>;
}

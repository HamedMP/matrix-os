import { ConnectionMethodCard } from "./ConnectionMethodCard.js";
import { hasConfiguredConnection } from "./harness-connection.js";
import type { ProviderHarnessInstance } from "@matrix-os/contracts";

/** Unsupported or owner-restricted connections remain in Settings without a Terminal detour. */
export function ConnectionFallback({ harness, workflowPermission = "unknown" }: {
  harness: ProviderHarnessInstance;
  disabled: boolean;
  workflowPermission?: "unknown" | "available" | "forbidden";
  onSetupHarness?: (kind: ProviderHarnessInstance["harness"]) => Promise<boolean>;
}) {
  if (hasConfiguredConnection(harness) || harness.installState !== "installed") return null;
  const subscription = harness.harness === "codex" ? "ChatGPT" : harness.harness === "claude" ? "Claude" : null;
  const reason = workflowPermission === "forbidden"
    ? "Only this computer’s owner can manage connections."
    : "Connection in Settings is unavailable on this computer. Refresh or update the computer to try again.";
  return <section className="matrix-ap-workflow" aria-label={`${harness.displayName} connection`}>
    <h3>Connect {harness.displayName} with</h3>
    {subscription ? <div className="matrix-ap-connection-options">
      <ConnectionMethodCard method="account" title={`${subscription} account`} recommended description={`Use your ${subscription} plan`} disabled tooltip={reason} />
      <ConnectionMethodCard method="key" title="API key" description={`Pay ${harness.harness === "codex" ? "OpenAI" : "Anthropic"} per request`} disabled tooltip={reason} />
    </div> : null}
    {workflowPermission !== "forbidden" ? <p className="matrix-ap-help" role="status">{reason}</p> : null}
  </section>;
}

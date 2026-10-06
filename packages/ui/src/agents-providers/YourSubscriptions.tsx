import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { hasConfiguredConnection, resolveHarnessConnection } from "./harness-connection.js";
import { resolvedWorkflowRowStatus } from "./workflow-row-status.js";
import { usageLines } from "./utils.js";
import { managedConnectionCapability } from "./managed-connection-capability.js";
import type { ProviderWorkflowClient, ProviderWorkflowUICapability } from "./types.js";

type Props = {
  snapshot: ProviderSettingsSnapshot;
  capabilities: readonly ProviderWorkflowUICapability[];
  client?: ProviderWorkflowClient;
  operationIds: Readonly<Record<string, string>>;
  workflowStatus: Readonly<Record<string, string>>;
  forbidden: boolean;
  disabled: boolean;
  onOpen: (id: string, kind: "codex" | "claude") => void;
  onRefresh: () => void;
};

/** Display-only shortcuts into the single native workflow; never initiate auth here. */
export function YourSubscriptions({snapshot, capabilities, client, operationIds, workflowStatus, forbidden, disabled, onOpen, onRefresh}: Props) {
  return <section className="matrix-ap-subscriptions" aria-label="Your subscriptions">
    <h3>Your subscriptions</h3>
    <p className="matrix-ap-help">Connect your accounts on this Computer. Subscription usage is separate from Matrix AI credit.</p>
    <div className="matrix-ap-subscription-list">
      {(["codex", "claude"] as const).flatMap(kind => {
        const saved = snapshot.harnesses.filter(item => item.harness === kind);
        const inventory = saved.length ? [] : capabilities.filter(item => item.harness === kind);
        const targets = [...saved.map(harness => ({id: harness.id, harness, capability: capabilities.find(item => item.harnessInstanceId === harness.id)})),
          ...inventory.map(capability => ({id: capability.harnessInstanceId, harness: undefined, capability}))];
        const name = kind === "codex" ? "Codex" : "Claude";
        const nativeName = kind === "codex" ? "Codex" : "Claude Code";
        const rows = targets.length ? targets : [{id: kind, harness: undefined, capability: undefined}];
        return rows.map(({id, harness, capability: advertisedCapability}) => {
          const capability = advertisedCapability ? managedConnectionCapability(advertisedCapability) : undefined;
          const {account, source} = harness ? resolveHarnessConnection(harness, snapshot.accounts, snapshot.accessSources) : {account: undefined, source: undefined};
          const keyAccount = source?.fundingKind === "owner_api_key" || account?.authMethod === "api_key";
          const connected = harness && (kind === "claude" || keyAccount) ? hasConfiguredConnection(harness, source) : false;
          const retained = harness && (kind === "claude" || keyAccount) ? hasConfiguredConnection({...harness, enabled: true, configuredEnabled: true}, source) : false;
          const status = harness ? resolvedWorkflowRowStatus(harness, source, workflowStatus[id]) : workflowStatus[id] ?? "Not connected";
          const continuing = ["Connecting", "Installing", "Uninstalling"].includes(status)
            || Boolean(operationIds[id] || capability?.activeOperationId);
          const installState = harness?.installState ?? capability?.installState;
          const canInstall = installState !== "installed" && capability?.install;
          const options = capability?.connectionOptions;
          const canLogin = capability && installState === "installed" && (options
            ? Boolean(client?.startConnection && options.some(option => option.providerId === (kind === "codex" ? "openai" : "anthropic") && option.authKind === "subscription" && option.availability === "available"))
            : Boolean(client && capability.loginMethods.length));
          const canKey = kind === "codex" && capability && installState === "installed" && (options
            ? Boolean(client?.submitConnectionKey && options.some(option => option.providerId === "openai" && option.authKind === "api_key" && option.availability === "available"))
            : Boolean(client?.submitKey && capability.apiKeyProviders.includes("openai")));
          const writable = !forbidden && snapshot.access.mode !== "read_only";
          const action = continuing && writable ? `${kind === "codex" ? "Review" : "Continue"} ${name} connection` : connected || retained || (kind === "codex" && account && canKey) ? `Manage ${name} connection`
            : !writable ? null
            : canInstall ? `Install ${name}` : canLogin || canKey ? `Connect ${name}` : null;
          const usage = source?.fundingKind === "owner_subscription" && source.usage.kind === "subscription_allowance" ? usageLines(source.usage) : null;
          return <article className="matrix-ap-subscription" key={`${kind}:${id}`}>
            <div className="matrix-ap-subscription-head"><strong>{nativeName}{rows.length > 1 ? ` · ${harness?.displayName ?? capability?.displayName}` : ""}</strong>
              <span className="matrix-ap-status-chip" data-state={connected ? "ready" : "attention"}><i aria-hidden="true"/>{continuing ? status === "Not connected" ? "Connecting" : status : connected ? "Connected" : retained ? "Saved connection" : kind === "codex" && account ? "Saved account" : installState === "missing" ? "Not installed" : "Not connected"}</span>
            </div>
            <p className="matrix-ap-help">{kind === "codex" ? "Codex subscription connections are not currently supported on managed Computers." : "Use your Claude plan through official Claude Code. Bot task permission is configured separately."}</p>
            {kind === "codex" && canKey ? <p className="matrix-ap-help">Connect with an OpenAI API key, billed per request by OpenAI. Matrix AI credit is separate.</p> : null}
            {account || source ? <p className="matrix-ap-help">{account?.connectionDetails?.email ?? account?.displayName ?? source?.displayName}</p> : null}
            {connected || retained ? <p className="matrix-ap-help">{source?.fundingKind === "owner_api_key" ? "API key connected · billed by your provider" : usage?.primary ?? "Usage unavailable"}{usage?.secondary ? ` · ${usage.secondary}` : ""}</p> : null}
            {action ? <button type="button" className="matrix-ap-button" disabled={disabled} aria-controls={`matrix-ap-details-${id}`}
              onClick={() => onOpen(id, kind)}>{action}</button> : <p className="matrix-ap-help">{forbidden || snapshot.access.mode === "read_only" ? "Only this Computer’s owner can manage connections." : `${nativeName} connection is unavailable on this Computer. Refresh or update this Computer to check supported sign-in methods.`}</p>}
          </article>;
        });
      })}
    </div>
    {!forbidden && snapshot.access.mode !== "read_only" ? <button type="button" className="matrix-ap-link-button" disabled={disabled} onClick={onRefresh}>Check subscription connections</button> : null}
  </section>;
}

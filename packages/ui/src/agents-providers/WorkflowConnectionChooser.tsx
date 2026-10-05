import { ConnectionMethodCard } from "./ConnectionMethodCard.js";
import type { HarnessWorkflowController } from "./use-harness-workflow-controller.js";
const providerNames = {openai: "ChatGPT", anthropic: "Claude", openrouter: "OpenRouter"};
const keyNames = {openai: "OpenAI", anthropic: "Anthropic", openrouter: "OpenRouter"};
const methodNames = {device_code: "Sign in with a code", browser: "Sign in in browser", existing_codex: "Use existing Codex account", terminal: "Sign in in Terminal"};
const unavailable = {not_installed: "Install this agent on this computer to connect.", unsupported_runtime: "This connection requires a supported agent version.", provider_access_required: "This connection requires provider access for this deployment."};

/** Only exact, qualified server options can start a provider-aware connection. */
export function WorkflowConnectionChooser({state}: {state: HarnessWorkflowController}) {
 const {capability, harness, disabled, pending, connecting, selectedOption, setSelectedOption,
   setMethod, setProviderId, setApiKey, setOperation, setFailure, pendingStart, start} = state;
 if (!capability.connectionOptions?.length) return <p className="matrix-ap-help" role="status">Connection in Settings is unavailable for this agent on this computer.</p>;
 return <>
   <h3>Connect {harness.displayName} with</h3>
   <div className="matrix-ap-connection-options">
     {capability.connectionOptions?.map(option => {
       const key = option.authKind === "api_key";
       const available = option.availability === "available" && (key ? !!state.client.submitConnectionKey : !!state.client.startConnection);
       return <div key={option.id}>
         <ConnectionMethodCard method={key ? "key" : "account"}
           title={key ? `${keyNames[option.providerId]} API key` : `${providerNames[option.providerId]} account · ${option.method ? methodNames[option.method] : "Sign in"}`}
           description={key ? "Billed per request by your provider" : "Uses your subscription for this agent on this computer"}
           selected={selectedOption?.id === option.id} disabled={disabled || pending || connecting || !available}
           onClick={() => {
             pendingStart.current = null; setSelectedOption(option); setProviderId(option.providerId);
             setApiKey(""); setOperation(null); setFailure(null); setMethod(key ? "key" : "account");
             if (!key) void start("login", option.method === "terminal", option);
           }} />
         {!available ? <p className="matrix-ap-help" role="status">{option.unavailableReason ? unavailable[option.unavailableReason] : "This connection is unavailable in this app version."}</p> : null}
       </div>;
     })}
   </div>
 </>;
}

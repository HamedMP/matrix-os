import { ConnectionMethodCard } from "./ConnectionMethodCard.js";
import { isCodexExistingAccountOption } from "./managed-connection-capability.js";
import type { HarnessWorkflowController } from "./use-harness-workflow-controller.js";
const providerNames = {openai: "ChatGPT", anthropic: "Claude", openrouter: "OpenRouter"};
const keyNames = {openai: "OpenAI", anthropic: "Anthropic", openrouter: "OpenRouter"};
const methodNames = {device_code: "Sign in with a code", browser: "Sign in in browser", existing_codex: "Use existing Codex account", terminal: "Log in in Terminal"};
const unavailable = {not_installed: "Install this agent on this computer to connect.", unsupported_runtime: "This connection requires a supported agent version.", provider_access_required: "This connection requires provider access for this deployment."};

/** Only exact, qualified server options can start a provider-aware connection. */
export function WorkflowConnectionChooser({state}: {state: HarnessWorkflowController}) {
 const {capability, harness, disabled, pending, startingLogin, connecting, selectedOption, setSelectedOption,
   operationId, operation, setMethod, setProviderId, setApiKey, setOperation, setFailure, pendingStart: pendingStartRef, start} = state;
 const { connectionOptions } = capability;
 if (!connectionOptions?.length) return <p className="matrix-ap-help" role="status">Connection in Settings is unavailable for this agent on this computer.</p>;
 const codex = harness.harness === "codex";
 const useExistingCodexAccount = codex && connectionOptions.some(isCodexExistingAccountOption);
 const options = useExistingCodexAccount
   ? connectionOptions.filter(option => option.authKind === "api_key" || isCodexExistingAccountOption(option))
   : connectionOptions;
 const restoringCodex = codex && operationId !== null && operation?.id !== operationId;
 return <div className="matrix-ap-login-choices">
   <h3>Connect {harness.displayName} with</h3>
   <div className="matrix-ap-connection-options">
     {options.map(option => {
       const key = option.authKind === "api_key";
       const available = option.availability === "available" && (key ? !!state.client.submitConnectionKey : !!state.client.startConnection);
       const existingCodexAccount = codex && isCodexExistingAccountOption(option);
       const methodName = codex && option.method === "terminal"
         ? "Sign in with Codex CLI"
         : option.method ? methodNames[option.method] : "Sign in";
       const title = key ? `${keyNames[option.providerId]} API key`
         : existingCodexAccount ? methodNames.existing_codex : `${providerNames[option.providerId]} account · ${methodName}`;
       return <div key={option.id}>
         <ConnectionMethodCard method={key ? "key" : "account"}
           title={title}
           description={key ? "Billed per request by your provider" : existingCodexAccount ? "Connect the ChatGPT account already signed in to Codex on this computer" : harness.harness === "hermes" ? "Sign in with your account in Terminal" : "Uses your subscription for this agent on this computer"}
           selected={selectedOption?.id === option.id} loading={startingLogin && selectedOption?.id === option.id} disabled={disabled || pending || connecting || restoringCodex || state.reconciling || !available}
           onClick={() => {
             pendingStartRef.current = null; setSelectedOption(option); setProviderId(option.providerId);
             setApiKey(""); setOperation(null); setFailure(null); setMethod(key ? "key" : "account");
             if (!key) void start("login", option.method === "terminal", option);
           }} />
         {!available ? <p className="matrix-ap-help" role="status">{option.unavailableReason ? unavailable[option.unavailableReason] : "This connection is unavailable in this app version."}</p> : null}
       </div>;
     })}
   </div>
 </div>;
}

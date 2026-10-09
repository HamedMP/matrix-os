import type { OnboardingAiChoice, OnboardingAiPanel, OnboardingAiProvider } from "@matrix-os/contracts";
import { Alert02Icon, CheckmarkCircle02Icon, Key01Icon, UserIcon } from "@hugeicons/core-free-icons";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { codingAgentArtworkSrc } from "../coding-agent-artwork.js";
import { ButtonRow, Icon, RabbitAvatar } from "./parts.js";
import { AI_KEY_MAX_CHARS, PROVIDER_COPY } from "./helpers.js";
import type { OnboardingWidgetActions } from "./types.js";

const PROVIDER_MARKS: Record<OnboardingAiProvider, string> = {
  claude: "/agents/settings/claude.svg",
  codex: "/agents/settings/openai.svg",
};
const SIGN_IN_CODE_MAX_CHARS = 4096;

function ProviderLogo({ provider }: { provider: OnboardingAiChoice }) {
  if (provider === "matrix") return <span className="mxo-logo mxo-logo--matrix" aria-hidden><RabbitAvatar size={20} /></span>;
  return (
    <span className="mxo-logo mxo-logo--provider" aria-hidden>
      <img src={codingAgentArtworkSrc(PROVIDER_MARKS[provider])} alt="" width={18} height={18} draggable={false} />
    </span>
  );
}

export function AiMenu({ choice, connected, actions }: { choice: OnboardingAiChoice; connected: readonly OnboardingAiProvider[]; actions: OnboardingWidgetActions }) {
  const row = (provider: OnboardingAiChoice, name: string, line: string) => {
    const isConnected = provider === "matrix" || connected.includes(provider);
    const selected = choice === provider;
    return (
      <button
        type="button"
        role="menuitemradio"
        aria-checked={selected}
        className="mxo-menu__row"
        onClick={() => actions.dispatch(isConnected ? { type: "ai.selected", provider } : { type: "ai.providerPicked", provider })}
      >
        <ProviderLogo provider={provider} />
        <span className="mxo-result__text">
          <span className="mxo-result__title">{name}</span>
          <span className="mxo-muted">{line}</span>
        </span>
        {selected ? <Icon icon={CheckmarkCircle02Icon} size={16} className="mxo-ok" /> : isConnected ? null : <span className="mxo-menu__action">Connect</span>}
      </button>
    );
  };
  return (
    <div className="mxo-popover mxo-ai-menu" role="menu" aria-label="Change AI">
      {row("matrix", "Matrix AI", "Free to start")}
      {row("claude", PROVIDER_COPY.claude.menuName, PROVIDER_COPY.claude.menuLine)}
      {row("codex", PROVIDER_COPY.codex.menuName, PROVIDER_COPY.codex.menuLine)}
      <div className="mxo-menu__sep" />
      <button type="button" role="menuitem" className="mxo-menu__row mxo-menu__row--plain" onClick={actions.openSettings}>More in Settings</button>
    </div>
  );
}

function SignInCodeForm({ actions }: { actions: OnboardingWidgetActions }) {
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = code.trim();
    if (!value || sent) return;
    setCode("");
    setSent(true);
    actions.submitAiCode(value);
  };
  return (
    <form className="mxo-code-entry" onSubmit={submit}>
      <input
        type="password"
        className="mxo-key__input"
        aria-label="Paste the sign-in code"
        placeholder="Paste code"
        autoComplete="off"
        spellCheck={false}
        maxLength={SIGN_IN_CODE_MAX_CHARS}
        value={code}
        disabled={sent}
        onChange={(event) => setCode(event.target.value)}
      />
      <button type="submit" className="mxo-btn mxo-btn--dark" disabled={sent || !code.trim()}>
        {sent ? "Finishing sign-in…" : "Finish connecting"}
      </button>
    </form>
  );
}

function WaitingStep({ panel, actions, signInCode, needsCode }: {
  panel: Extract<OnboardingAiPanel, { step: "waiting" }>;
  actions: OnboardingWidgetActions;
  signInCode: string | null;
  needsCode: boolean;
}) {
  const copy = PROVIDER_COPY[panel.provider];
  const failed = panel.status === "failed";
  const line = failed ? `I couldn't connect ${copy.name}.` : needsCode ? "Sign in on the tab I opened, then paste the code it shows." : "Finish signing in on the tab I opened.";
  return (
    <>
      <p className="mxo-text">{line}</p>
      <div className="mxo-card mxo-connect">
        <div className="mxo-connect__row">
          <ProviderLogo provider={panel.provider} />
          <span className="mxo-result__text">
            <span className="mxo-result__title">{copy.name}</span>
            {failed
              ? <span className="mxo-failed-line"><Icon icon={Alert02Icon} size={12} />Sign-in didn't finish</span>
              : <span className="mxo-muted">{signInCode ? <>Code: <strong className="mxo-code">{signInCode}</strong></> : "Waiting for sign-in…"}</span>}
          </span>
        </div>
        {!failed && needsCode ? <SignInCodeForm actions={actions} /> : null}
        <ButtonRow>
          {failed ? (
            <>
              <button type="button" className="mxo-btn mxo-btn--dark" onClick={() => {
                actions.dispatch({ type: "ai.retried" });
                actions.startAiSignIn(panel.provider);
              }}>Try again</button>
              <button type="button" className="mxo-btn mxo-btn--ghost" onClick={() => actions.dispatch({ type: "ai.cancelled" })}>Skip</button>
            </>
          ) : (
            <>
              <button type="button" className="mxo-btn mxo-btn--outline" onClick={actions.reopenAiSignIn}>Reopen tab</button>
              <button type="button" className="mxo-btn mxo-btn--ghost" onClick={actions.cancelAiSignIn}>Cancel</button>
            </>
          )}
        </ButtonRow>
      </div>
    </>
  );
}

export function AiFlow({ panel, actions, signInCode, needsCode = false }: {
  panel: Exclude<OnboardingAiPanel, { step: "menu" }>;
  actions: OnboardingWidgetActions;
  signInCode?: string | null;
  needsCode?: boolean;
}) {
  const copy = PROVIDER_COPY[panel.provider];
  const keyRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (panel.step === "key") keyRef.current?.focus();
  }, [panel.step]);

  if (panel.step === "method") {
    return (
      <>
        <p className="mxo-text">Connect {copy.name} to use it here.</p>
        <div className="mxo-card mxo-tasks">
          <button type="button" className="mxo-task" onClick={() => {
            actions.dispatch({ type: "ai.methodPicked", method: "account" });
            actions.startAiSignIn(panel.provider);
          }}>
            <span className="mxo-tile mxo-tile--neutral"><Icon icon={UserIcon} size={16} /></span>
            <span className="mxo-result__text">
              <span className="mxo-result__title">{copy.account}</span>
              <span className="mxo-muted">Sign in with your plan</span>
            </span>
            <span className="mxo-tag">Recommended</span>
          </button>
          <button type="button" className="mxo-task" onClick={() => actions.dispatch({ type: "ai.methodPicked", method: "api_key" })}>
            <span className="mxo-tile mxo-tile--neutral"><Icon icon={Key01Icon} size={16} /></span>
            <span className="mxo-result__text">
              <span className="mxo-result__title">API key</span>
              <span className="mxo-muted">Pay {copy.vendor} per request</span>
            </span>
          </button>
        </div>
        <button type="button" className="mxo-btn mxo-btn--ghost mxo-btn--start" onClick={() => actions.dispatch({ type: "ai.keepMatrix" })}>Keep Matrix AI</button>
      </>
    );
  }

  if (panel.step === "waiting") return <WaitingStep panel={panel} actions={actions} signInCode={signInCode ?? null} needsCode={needsCode} />;
  if (panel.step === "settings") {
    return (
      <>
        <p className="mxo-text">Finish connecting {copy.name} in Settings.</p>
        <ButtonRow>
          <button type="button" className="mxo-btn mxo-btn--dark" onClick={actions.openSettings}>Open Settings</button>
          <button type="button" className="mxo-btn mxo-btn--ghost" onClick={() => actions.dispatch({ type: "ai.keepMatrix" })}>Keep Matrix AI</button>
        </ButtonRow>
      </>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = keyRef.current;
    const key = input?.value.trim() ?? "";
    if (!input || !key) return;
    input.value = "";
    actions.dispatch({ type: "ai.keySubmitted" });
    actions.submitAiKey(panel.provider, key);
  };
  return (
    <>
      <p className="mxo-text">Paste your {copy.vendor} API key.</p>
      <form className="mxo-card mxo-key" onSubmit={submit}>
        <input
          ref={keyRef}
          type="password"
          className="mxo-key__input"
          placeholder={copy.keyPlaceholder}
          aria-label={`${copy.vendor} API key`}
          autoComplete="off"
          spellCheck={false}
          maxLength={AI_KEY_MAX_CHARS}
          disabled={panel.status === "saving"}
        />
        {panel.status === "failed"
          ? <span className="mxo-failed-line"><Icon icon={Alert02Icon} size={12} />That key didn't work</span>
          : <span className="mxo-muted">Stored on your computer only.</span>}
        <ButtonRow>
          <button type="submit" className="mxo-btn mxo-btn--dark" disabled={panel.status === "saving"}>
            {panel.status === "saving" ? "Connecting…" : "Connect"}
          </button>
          <button type="button" className="mxo-btn mxo-btn--ghost" onClick={() => actions.dispatch({ type: "ai.providerPicked", provider: panel.provider })}>Back</button>
        </ButtonRow>
      </form>
    </>
  );
}

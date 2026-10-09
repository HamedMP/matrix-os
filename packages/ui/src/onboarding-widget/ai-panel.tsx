import type { OnboardingAiChoice, OnboardingAiPanel, OnboardingAiProvider } from "@matrix-os/contracts";
import { Alert02Icon, CheckmarkCircle02Icon, Key01Icon, UserIcon } from "@hugeicons/core-free-icons";
import { useRef, type FormEvent } from "react";
import { CODING_AGENT_ARTWORK, codingAgentArtworkSrc } from "../coding-agent-artwork.js";
import { ButtonRow, Icon, RabbitAvatar } from "./parts.js";
import type { OnboardingWidgetActions } from "./types.js";

const PROVIDER_COPY: Record<OnboardingAiProvider, {
  name: string;
  menuName: string;
  menuLine: string;
  account: string;
  vendor: string;
  keyPlaceholder: string;
}> = {
  claude: {
    name: "Claude",
    menuName: "Claude",
    menuLine: "Use your Claude plan",
    account: "Claude account",
    vendor: "Anthropic",
    keyPlaceholder: "sk-ant-…",
  },
  codex: {
    name: "ChatGPT",
    menuName: "ChatGPT / Codex",
    menuLine: "Use your ChatGPT plan",
    account: "ChatGPT account",
    vendor: "OpenAI",
    keyPlaceholder: "sk-…",
  },
};

export const AI_KEY_MAX_CHARS = 512;

function ProviderLogo({ provider }: { provider: OnboardingAiChoice }) {
  if (provider === "matrix") return <RabbitAvatar size={28} />;
  const art = CODING_AGENT_ARTWORK[provider];
  return (
    <span className="mxo-logo mxo-logo--agent" style={{ background: art.background }} aria-hidden>
      <img src={codingAgentArtworkSrc(art.src)} alt="" width={28} height={28} />
    </span>
  );
}

export function providerWaitingLabel(panel: OnboardingAiPanel | null): string | null {
  return panel?.step === "waiting" && panel.status === "waiting" ? `Connecting ${PROVIDER_COPY[panel.provider].name}…` : null;
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

export function AiFlow({ panel, actions }: { panel: Exclude<OnboardingAiPanel, { step: "menu" }>; actions: OnboardingWidgetActions }) {
  const copy = PROVIDER_COPY[panel.provider];
  const keyRef = useRef<HTMLInputElement>(null);

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

  if (panel.step === "waiting") {
    const failed = panel.status === "failed";
    return (
      <>
        <p className="mxo-text">{failed ? `I couldn't connect ${copy.name}.` : "Finish signing in on the tab I opened."}</p>
        <div className="mxo-card mxo-connect">
          <div className="mxo-connect__row">
            <ProviderLogo provider={panel.provider} />
            <span className="mxo-result__text">
              <span className="mxo-result__title">{copy.name}</span>
              {failed
                ? <span className="mxo-failed-line"><Icon icon={Alert02Icon} size={12} />Sign-in didn't finish</span>
                : <span className="mxo-muted">Waiting for sign-in…</span>}
            </span>
          </div>
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
          autoFocus
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

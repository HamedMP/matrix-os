import {
  ONBOARDING_FREEFORM_MAX_CHARS,
  ONBOARDING_REPO_QUESTION,
  deriveOnboardingBubble,
  onboardingAiLabel,
  onboardingTask,
  parseOnboardingRepoUrl,
  type OnboardingWidgetState,
} from "@matrix-os/contracts";
import {
  ArrowExpand01Icon,
  ArrowShrink02Icon,
  ArrowUp02Icon,
  MinusSignIcon,
  MoreHorizontalIcon,
  PinIcon,
} from "@hugeicons/core-free-icons";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { AiFlow, AiMenu, providerWaitingLabel } from "./ai-panel.js";
import { DoneLine, Icon, RabbitAvatar, StatusDot, UserEcho } from "./parts.js";
import { AppsScreen, ConnectScreen, QuestionScreen, RepoScreen, RunScreen, TasksScreen } from "./screens.js";
import type { OnboardingWidgetProps } from "./types.js";

function headerStatus(state: OnboardingWidgetState): { tone: "working" | "attention"; label: string } | null {
  const connecting = providerWaitingLabel(state.ai);
  if (connecting) return { tone: "attention", label: connecting };
  if (state.screen.kind !== "run") return null;
  if (state.screen.phase === "waiting_computer") return { tone: "attention", label: "Starting your computer…" };
  if (state.screen.phase === "starting" || state.screen.phase === "running") return { tone: "working", label: "Working…" };
  return null;
}

function placeholderFor(state: OnboardingWidgetState): string {
  const screen = state.screen;
  if (screen.kind === "apps") return "Or type an app name…";
  if (screen.kind === "repo") return ONBOARDING_REPO_QUESTION.placeholder;
  if (screen.kind === "question") return onboardingTask(screen.taskId)?.question?.placeholder ?? "Or type what you need…";
  return "Or type what you need…";
}

function Toggle({ on }: { on: boolean }) {
  return <span className={`mxo-toggle${on ? " mxo-toggle--on" : ""}`} aria-hidden><span /></span>;
}

export function OnboardingWidget(props: OnboardingWidgetProps) {
  const { state, actions, prefs, runView, zIndex = 45 } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [appQuery, setAppQuery] = useState("");
  const isBubble = state.size === "bubble";
  const keepInCorner = prefs.keepInCorner;

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && event.shiftKey && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        actions.openFullChat();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions]);

  useEffect(() => {
    if (isBubble || keepInCorner) return;
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) {
        actions.dispatch({ type: "size.changed", size: "bubble" });
      }
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [actions, isBubble, keepInCorner]);

  const open = () => {
    actions.dispatch({ type: "size.changed", size: "corner" });
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const minimize = () => {
    setMoreOpen(false);
    actions.dispatch({ type: "size.changed", size: "bubble" });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    if (moreOpen) setMoreOpen(false);
    else if (state.ai?.step === "menu") actions.dispatch({ type: "ai.menuToggled" });
    else minimize();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim().slice(0, ONBOARDING_FREEFORM_MAX_CHARS);
    if (!text || state.screen.kind === "apps") return;
    setDraft("");
    if (state.screen.kind === "repo") {
      const repo = parseOnboardingRepoUrl(text);
      if (repo) {
        actions.dispatch({ type: "answer.submitted", text: repo.name, context: repo.url });
        return;
      }
    }
    actions.dispatch(state.screen.kind === "question" ? { type: "answer.submitted", text } : { type: "freeform.submitted", text });
  };

  const sideClass = prefs.side === "left" ? " mxo-root--left" : "";

  if (isBubble) {
    const bubble = deriveOnboardingBubble(state, runView);
    return (
      <div className={`mxo-root${sideClass}`} style={{ zIndex }}>
        <button type="button" className="mxo-bubble" onClick={open} aria-label={`Open Matrix. ${bubble.title}. ${bubble.subtitle}`}>
          <RabbitAvatar size={32} />
          <span className="mxo-bubble__text">
            <span className="mxo-bubble__title">
              {bubble.tone === "working" ? <StatusDot tone="working" /> : bubble.tone === "attention" ? <StatusDot tone="attention" /> : null}
              {bubble.title}
            </span>
            <span className="mxo-bubble__subtitle">{bubble.subtitle}</span>
          </span>
          {bubble.count > 0 ? <span className="mxo-badge" aria-label={`${bubble.count} new`}>{bubble.count}</span> : null}
        </button>
      </div>
    );
  }

  const status = headerStatus(state);
  const aiFlow = state.ai && state.ai.step !== "menu" ? state.ai : null;
  const screen = state.screen;

  return (
    <div ref={rootRef} className={`mxo-root${sideClass}`} style={{ zIndex }} onKeyDown={onKeyDown}>
      <section className="mxo-card mxo-widget" aria-label="Matrix" role="dialog">
        <header className="mxo-header">
          <RabbitAvatar size={30} />
          <span className="mxo-header__text">
            <span className="mxo-header__name">Matrix</span>
            {status ? <span className="mxo-header__status"><StatusDot tone={status.tone} />{status.label}</span> : null}
          </span>
          <span className="mxo-header__actions">
            {keepInCorner ? <span className="mxo-icon-btn mxo-icon-btn--active" title="Kept in the corner"><Icon icon={PinIcon} size={14} /></span> : null}
            <button type="button" className="mxo-icon-btn" aria-label="More" aria-expanded={moreOpen} aria-haspopup="menu" onClick={() => setMoreOpen((value) => !value)}>
              <Icon icon={MoreHorizontalIcon} size={16} />
            </button>
            <button type="button" className="mxo-icon-btn" aria-label="Minimize" onClick={minimize}>
              <Icon icon={MinusSignIcon} size={16} />
            </button>
            <button type="button" className="mxo-icon-btn" aria-label="Open as full chat" onClick={actions.openFullChat}>
              <Icon icon={ArrowExpand01Icon} size={14} />
            </button>
          </span>
          {moreOpen ? (
            <div className="mxo-popover mxo-more" role="menu" aria-label="Matrix options">
              <button type="button" role="menuitemcheckbox" aria-checked={keepInCorner} className="mxo-menu__row mxo-menu__row--compact"
                onClick={() => actions.changePrefs({ ...prefs, keepInCorner: !keepInCorner })}>
                <Icon icon={PinIcon} size={14} /><span>Keep in the corner</span><Toggle on={keepInCorner} />
              </button>
              <button type="button" role="menuitem" className="mxo-menu__row mxo-menu__row--compact" onClick={() => { setMoreOpen(false); actions.openFullChat(); }}>
                <Icon icon={ArrowExpand01Icon} size={14} /><span>Open as full chat</span><kbd>⌘⇧K</kbd>
              </button>
              <button type="button" role="menuitem" className="mxo-menu__row mxo-menu__row--compact" onClick={minimize}>
                <Icon icon={ArrowShrink02Icon} size={14} /><span>Shrink to a bubble</span>
              </button>
              <div className="mxo-menu__sep" />
              <button type="button" role="menuitem" className="mxo-menu__row mxo-menu__row--compact"
                onClick={() => { setMoreOpen(false); actions.changePrefs({ ...prefs, side: prefs.side === "left" ? "right" : "left" }); }}>
                <span>{prefs.side === "left" ? "Move to the right corner" : "Move to the left corner"}</span>
              </button>
              <button type="button" role="menuitemcheckbox" aria-checked={prefs.showOnLogin} className="mxo-menu__row mxo-menu__row--compact"
                onClick={() => actions.changePrefs({ ...prefs, showOnLogin: !prefs.showOnLogin })}>
                <span>Show on every login</span><Toggle on={prefs.showOnLogin} />
              </button>
            </div>
          ) : null}
        </header>

        <div className="mxo-body" aria-live="polite">
          {state.echo ? <UserEcho text={state.echo} /> : null}
          {state.notice ? <DoneLine text={state.notice} /> : null}
          {aiFlow ? <AiFlow panel={aiFlow} actions={actions} /> : (
            <>
              {screen.kind === "tasks" ? <TasksScreen state={state} apps={props.apps} userName={props.userName} actions={actions} /> : null}
              {screen.kind === "apps" ? <AppsScreen apps={props.apps} actions={actions} query={appQuery} onQuery={setAppQuery} /> : null}
              {screen.kind === "question" ? <QuestionScreen taskId={screen.taskId} actions={actions} /> : null}
              {screen.kind === "connect" ? <ConnectScreen taskId={screen.taskId} status={screen.status} apps={props.apps} actions={actions} /> : null}
              {screen.kind === "repo" ? <RepoScreen repos={props.repos} actions={actions} /> : null}
              {screen.kind === "run" ? <RunScreen run={screen} state={state} runView={runView} creditsExhausted={props.creditsExhausted} actions={actions} /> : null}
              {screen.kind !== "tasks" && screen.kind !== "apps" && !(screen.kind === "run" && (screen.phase === "starting" || screen.phase === "running")) ? (
                <button type="button" className="mxo-link mxo-link--quiet" onClick={() => actions.dispatch({ type: "tasks.requested" })}>All tasks</button>
              ) : null}
            </>
          )}
        </div>

        <footer className="mxo-footer">
          {state.ai?.step === "menu" ? <AiMenu choice={state.aiChoice} connected={props.connectedProviders} actions={actions} /> : null}
          <form className="mxo-composer" onSubmit={submit}>
            <input
              ref={inputRef}
              value={screen.kind === "apps" ? appQuery : draft}
              onChange={(event) => (screen.kind === "apps" ? setAppQuery(event.target.value) : setDraft(event.target.value))}
              placeholder={placeholderFor(state)}
              aria-label="Message Matrix"
              maxLength={ONBOARDING_FREEFORM_MAX_CHARS}
              autoFocus
            />
            <button type="submit" className="mxo-send" aria-label="Send" disabled={screen.kind === "apps" || !draft.trim()}>
              <Icon icon={ArrowUp02Icon} size={14} />
            </button>
          </form>
          <p className="mxo-model-line">
            {onboardingAiLabel(state.aiChoice)} · <button type="button" className="mxo-inline-link" aria-expanded={state.ai?.step === "menu"} onClick={() => actions.dispatch({ type: "ai.menuToggled" })}>Change</button>
          </p>
        </footer>
      </section>
    </div>
  );
}

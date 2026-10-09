import {
  deriveOnboardingBubble,
  onboardingAiLabel,
  type OnboardingRunView,
  type OnboardingWidgetState,
} from "@matrix-os/contracts";
import { ArrowExpand01Icon, ArrowShrink02Icon, MinusSignIcon, MoreHorizontalIcon, PinIcon } from "@hugeicons/core-free-icons";
import type { Ref } from "react";
import { AiFlow } from "./ai-panel.js";
import { DoneLine, Icon, RabbitAvatar, StatusDot, UserEcho } from "./parts.js";
import { AppsScreen, ConnectScreen, QuestionScreen, RepoScreen, RunScreen, TasksScreen } from "./screens.js";
import type { OnboardingWidgetPrefs, OnboardingWidgetProps } from "./types.js";

function Toggle({ on }: { on: boolean }) {
  return <span className={`mxo-toggle${on ? " mxo-toggle--on" : ""}`} aria-hidden><span /></span>;
}

export function OnboardingBubble({ state, runView, buttonRef, onOpen }: {
  state: OnboardingWidgetState;
  runView: OnboardingRunView | null;
  buttonRef: Ref<HTMLButtonElement>;
  onOpen(): void;
}) {
  const bubble = deriveOnboardingBubble(state, runView);
  return (
    <button ref={buttonRef} type="button" className="mxo-bubble" onClick={onOpen} aria-label={`Open Matrix. ${bubble.title}. ${bubble.subtitle}`}>
      <RabbitAvatar size={32} />
      <span className="mxo-bubble__text">
        <span className="mxo-bubble__title">
          {bubble.tone === "working" || bubble.tone === "attention" ? <StatusDot tone={bubble.tone} /> : null}
          {bubble.title}
        </span>
        <span className="mxo-bubble__subtitle">{bubble.subtitle}</span>
      </span>
      {bubble.count > 0 ? <span className="mxo-badge" aria-label={`${bubble.count} new`}>{bubble.count}</span> : null}
    </button>
  );
}

export function MoreMenu({ prefs, onPrefs, onFullChat, onShrink, onClose }: {
  prefs: OnboardingWidgetPrefs;
  onPrefs(prefs: OnboardingWidgetPrefs): void;
  onFullChat(): void;
  onShrink(): void;
  onClose(): void;
}) {
  return (
    <div className="mxo-popover mxo-more" role="menu" aria-label="Matrix options">
      <button type="button" role="menuitemcheckbox" aria-checked={prefs.keepInCorner} className="mxo-menu__row mxo-menu__row--compact"
        onClick={() => onPrefs({ ...prefs, keepInCorner: !prefs.keepInCorner })}>
        <Icon icon={PinIcon} size={14} /><span>Keep in the corner</span><Toggle on={prefs.keepInCorner} />
      </button>
      <button type="button" role="menuitem" className="mxo-menu__row mxo-menu__row--compact" onClick={() => { onClose(); onFullChat(); }}>
        <Icon icon={ArrowExpand01Icon} size={14} /><span>Open as full chat</span><kbd>⌘⇧K</kbd>
      </button>
      <button type="button" role="menuitem" className="mxo-menu__row mxo-menu__row--compact" onClick={onShrink}>
        <Icon icon={ArrowShrink02Icon} size={14} /><span>Shrink to a bubble</span>
      </button>
      <div className="mxo-menu__sep" />
      <button type="button" role="menuitem" className="mxo-menu__row mxo-menu__row--compact"
        onClick={() => { onClose(); onPrefs({ ...prefs, side: prefs.side === "left" ? "right" : "left" }); }}>
        <span>{prefs.side === "left" ? "Move to the right corner" : "Move to the left corner"}</span>
      </button>
      <button type="button" role="menuitemcheckbox" aria-checked={prefs.showOnLogin} className="mxo-menu__row mxo-menu__row--compact"
        onClick={() => onPrefs({ ...prefs, showOnLogin: !prefs.showOnLogin })}>
        <span>Show on every login</span><Toggle on={prefs.showOnLogin} />
      </button>
    </div>
  );
}

export function WidgetHeader({ status, prefs, actions, moreOpen, onMoreOpen, onMinimize }: {
  status: { tone: "working" | "attention"; label: string } | null;
  prefs: OnboardingWidgetPrefs;
  actions: OnboardingWidgetProps["actions"];
  moreOpen: boolean;
  onMoreOpen(open: boolean): void;
  onMinimize(): void;
}) {
  return (
    <header className="mxo-header">
      <RabbitAvatar size={30} />
      <span className="mxo-header__text">
        <span className="mxo-header__name">Matrix</span>
        {status ? <span className="mxo-header__status"><StatusDot tone={status.tone} />{status.label}</span> : null}
      </span>
      <span className="mxo-header__actions">
        <button type="button" className="mxo-icon-btn" aria-label="More" aria-expanded={moreOpen} aria-haspopup="menu" onClick={() => onMoreOpen(!moreOpen)}>
          <Icon icon={MoreHorizontalIcon} size={16} />
        </button>
        {prefs.keepInCorner ? <span className="mxo-icon-btn mxo-icon-btn--active" title="Kept in the corner"><Icon icon={PinIcon} size={14} /></span> : null}
        <button type="button" className="mxo-icon-btn" aria-label="Minimize" onClick={onMinimize}>
          <Icon icon={MinusSignIcon} size={16} />
        </button>
        <button type="button" className="mxo-icon-btn" aria-label="Open as full chat" onClick={actions.openFullChat}>
          <Icon icon={ArrowExpand01Icon} size={14} />
        </button>
      </span>
      {moreOpen ? (
        <MoreMenu prefs={prefs} onPrefs={actions.changePrefs} onFullChat={actions.openFullChat} onShrink={onMinimize} onClose={() => onMoreOpen(false)} />
      ) : null}
    </header>
  );
}

export function ModelLine({ state, actions }: Pick<OnboardingWidgetProps, "state" | "actions">) {
  return (
    <p className="mxo-model-line">
      {onboardingAiLabel(state.aiChoice)} · <button type="button" className="mxo-inline-link" aria-expanded={state.ai?.step === "menu"} onClick={() => actions.dispatch({ type: "ai.menuToggled" })}>Change</button>
    </p>
  );
}

function ScreenView({ props, appQuery, onAppQuery }: { props: OnboardingWidgetProps; appQuery: string; onAppQuery(query: string): void }) {
  const { state, actions } = props;
  const screen = state.screen;
  switch (screen.kind) {
    case "tasks": return <TasksScreen state={state} apps={props.apps} userName={props.userName} actions={actions} />;
    case "apps": return <AppsScreen apps={props.apps} actions={actions} query={appQuery} onQuery={onAppQuery} />;
    case "question": return <QuestionScreen taskId={screen.taskId} actions={actions} />;
    case "connect": return <ConnectScreen taskId={screen.taskId} status={screen.status} apps={props.apps} actions={actions} />;
    case "repo": return <RepoScreen repos={props.repos} actions={actions} />;
    case "run": return <RunScreen run={screen} state={state} runView={props.runView} creditsExhausted={props.creditsExhausted} actions={actions} />;
  }
}

export function WidgetBody({ props, appQuery, onAppQuery, runInFlight }: {
  props: OnboardingWidgetProps;
  appQuery: string;
  onAppQuery(query: string): void;
  runInFlight: boolean;
}) {
  const { state, actions } = props;
  const aiFlow = state.ai && state.ai.step !== "menu" ? state.ai : null;
  const showAllTasks = state.screen.kind !== "tasks" && state.screen.kind !== "apps" && !runInFlight;
  return (
    <div className="mxo-body" aria-live="polite">
      {state.echo ? <UserEcho text={state.echo} /> : null}
      {state.notice ? <DoneLine text={state.notice} /> : null}
      {aiFlow ? <AiFlow panel={aiFlow} actions={actions} signInCode={props.aiSignInCode ?? null} /> : (
        <>
          <ScreenView props={props} appQuery={appQuery} onAppQuery={onAppQuery} />
          {showAllTasks ? (
            <button type="button" className="mxo-link mxo-link--quiet" onClick={() => actions.dispatch({ type: "tasks.requested" })}>All tasks</button>
          ) : null}
        </>
      )}
    </div>
  );
}

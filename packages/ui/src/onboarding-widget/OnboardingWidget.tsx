import {
  ONBOARDING_FREEFORM_MAX_CHARS,
  ONBOARDING_REPO_QUESTION,
  onboardingRunInFlight,
  onboardingTask,
  parseOnboardingRepoUrl,
  type OnboardingRunView,
  type OnboardingWidgetEvent,
  type OnboardingWidgetState,
} from "@matrix-os/contracts";
import { ArrowUp02Icon } from "@hugeicons/core-free-icons";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { AiMenu } from "./ai-panel.js";
import { providerWaitingLabel } from "./helpers.js";
import { Icon } from "./parts.js";
import type { OnboardingWidgetProps } from "./types.js";
import { useAppsVisit } from "./use-apps-visit.js";
import { useMenuFocus } from "./use-menu-focus.js";
import { useWidgetDrag, useWidgetPlacement } from "./use-widget-position.js";
import { ModelLine, OnboardingBubble, WidgetBody, WidgetHeader } from "./widget-chrome.js";

function headerStatus(state: OnboardingWidgetState, runView: OnboardingRunView | null): { tone: "working" | "attention"; label: string } | null {
  const connecting = providerWaitingLabel(state.ai);
  if (connecting) return { tone: "attention", label: connecting };
  if (state.screen.kind !== "run") return null;
  if (state.screen.phase === "waiting_computer") return { tone: "attention", label: "Starting your computer…" };
  if (state.screen.phase === "running" && runView?.status === "waiting") return { tone: "attention", label: "Needs your OK" };
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

function composerEvent(state: OnboardingWidgetState, text: string): OnboardingWidgetEvent {
  if (state.screen.kind === "repo") {
    const repo = parseOnboardingRepoUrl(text);
    if (repo) return { type: "answer.submitted", text: repo.name, context: repo.url };
  }
  return state.screen.kind === "question" ? { type: "answer.submitted", text } : { type: "freeform.submitted", text };
}

export function OnboardingWidget(props: OnboardingWidgetProps) {
  const { state, actions, prefs, runView, zIndex = 45, onSizeChange } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const bubbleRef = useRef<HTMLButtonElement>(null);
  const focusBubbleRef = useRef(false);
  const [draft, setDraft] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const isApps = state.screen.kind === "apps";
  const appsVisit = useAppsVisit(isApps, props.apps);
  const isBubble = state.size === "bubble";
  const keepInCorner = prefs.keepInCorner;
  const runInFlight = onboardingRunInFlight(state);
  const placement = useWidgetPlacement(rootRef, prefs.position, onSizeChange);
  const drag = useWidgetDrag(rootRef, (position) => actions.changePrefs({ ...prefs, position }));

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

  const aiMenuOpen = state.ai?.step === "menu";
  useEffect(() => {
    if (!moreOpen && !aiMenuOpen) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const inside = (menu: string) => Boolean(target?.closest(`[data-mxo-menu="${menu}"], [data-mxo-menu-toggle="${menu}"]`));
      if (moreOpen && !inside("more")) setMoreOpen(false);
      if (aiMenuOpen && !inside("ai")) actions.dispatch({ type: "ai.cancelled" });
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [actions, aiMenuOpen, moreOpen]);
  useMenuFocus(rootRef, "more", moreOpen);
  useMenuFocus(rootRef, "ai", aiMenuOpen);

  useEffect(() => {
    if (!isBubble || !focusBubbleRef.current) return;
    focusBubbleRef.current = false;
    bubbleRef.current?.focus();
  }, [isBubble]);

  const open = () => {
    actions.dispatch({ type: "size.changed", size: "corner" });
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const minimize = () => {
    setMoreOpen(false);
    focusBubbleRef.current = true;
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
    if (!text || isApps || runInFlight) return;
    setDraft("");
    actions.dispatch(composerEvent(state, text));
  };

  // `ph-no-capture` keeps sign-in codes, prompts and repo names out of session replay.
  const rootClass = `mxo-root ph-no-capture${prefs.position.x === "left" ? " mxo-root--left" : ""}${prefs.position.y === "top" ? " mxo-root--top" : ""}`;
  const rootStyle = { zIndex, ...placement };

  if (isBubble) {
    return (
      <div ref={rootRef} className={rootClass} style={rootStyle}>
        <OnboardingBubble state={state} runView={runView} buttonRef={bubbleRef} dragHandle={drag.handle} onClickCapture={drag.onClickCapture} onOpen={open} />
      </div>
    );
  }

  const choosingAi = state.ai !== null;
  const compact = (state.screen.kind === "tasks" || isApps) && (!choosingAi || state.ai?.step === "menu");
  const showModelLine = state.screen.kind === "tasks" || choosingAi;

  return (
    <div ref={rootRef} className={rootClass} style={rootStyle} onKeyDown={onKeyDown} onClickCapture={drag.onClickCapture}>
      <section className={`mxo-card mxo-widget${compact ? "" : " mxo-widget--tall"}`} aria-label="Matrix">
        <WidgetHeader
          status={headerStatus(state, runView)}
          prefs={prefs}
          actions={actions}
          dragHandle={drag.handle}
          moreOpen={moreOpen}
          onMoreOpen={setMoreOpen}
          onMinimize={minimize}
        />

        <WidgetBody props={props} apps={appsVisit} runInFlight={runInFlight} />

        <footer className="mxo-footer">
          {state.ai?.step === "menu" ? <AiMenu choice={props.activeAi} matrixAvailable={props.matrixAvailable} connected={props.connectedProviders} actions={actions} /> : null}
          <form className="mxo-composer" onSubmit={submit}>
            <input
              ref={inputRef}
              value={isApps ? appsVisit.appQuery : draft}
              onChange={(event) => (isApps ? appsVisit.onAppQuery(event.target.value) : setDraft(event.target.value))}
              placeholder={placeholderFor(state)}
              aria-label="Message Matrix"
              maxLength={ONBOARDING_FREEFORM_MAX_CHARS}
            />
            <button type="submit" className="mxo-send" aria-label="Send" disabled={isApps || runInFlight || !draft.trim()}>
              <Icon icon={ArrowUp02Icon} size={14} />
            </button>
          </form>
          {showModelLine ? <ModelLine state={state} actions={actions} activeAi={props.activeAi} matrixAvailable={props.matrixAvailable} /> : null}
        </footer>
      </section>
    </div>
  );
}

import {
  GET_STARTED_GOALS,
  getStartedAnswersFromWizard,
  getStartedQuestionProgress,
  getStartedToolGroupsForGoals,
  type GetStartedChoiceGroup,
  type GetStartedWizardEvent,
  type GetStartedWizardState,
} from "@matrix-os/contracts";
import { useEffect, useId, useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";
import { ButtonRow, RabbitAvatar, ToggleChip } from "../onboarding-widget/parts.js";
import { GetStartedConnectList, type GetStartedConnect } from "./connect.js";

export interface GetStartedWizardProps {
  wizard: GetStartedWizardState;
  submitting: boolean;
  error: string | null;
  dispatch(event: GetStartedWizardEvent): void;
  onFinish(): void;
  onSkipAll(): void;
  /** App connections for the last screen; absent when the surface cannot connect apps. */
  connect?: GetStartedConnect | null;
}

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])";

function ChoiceGroup({ group, wizard, dispatch }: {
  group: GetStartedChoiceGroup;
  wizard: GetStartedWizardState;
  dispatch(event: GetStartedWizardEvent): void;
}) {
  const titleId = useId();
  let chips: ReactNode;
  if (group.kind === "tools") {
    const picked = new Set(wizard.tools);
    chips = group.tools.map((tool) => (
      <ToggleChip key={tool.id} label={tool.label} pressed={picked.has(tool.id)} onToggle={() => dispatch({ type: "toggle-tool", tool: tool.id })} />
    ));
  } else if (group.kind === "app-idea") {
    chips = group.options.map((idea) => (
      <ToggleChip key={idea.id} label={idea.label} pressed={wizard.appIdea === idea.id} onToggle={() => dispatch({ type: "pick-app-idea", id: idea.id })} />
    ));
  } else {
    chips = group.options.map((starter) => (
      <ToggleChip key={starter.id} label={starter.label} pressed={wizard.starter === starter.id} onToggle={() => dispatch({ type: "pick-starter", id: starter.id })} />
    ));
  }
  return (
    <section className="mxo-gs__group" aria-labelledby={titleId}>
      <h3 id={titleId} className="mxo-muted">{group.title}</h3>
      <div className="mxo-chips">{chips}</div>
    </section>
  );
}

function Summary({ wizard }: { wizard: GetStartedWizardState }) {
  const picked = new Set(wizard.goals);
  const goals = GET_STARTED_GOALS.filter((goal) => picked.has(goal.id)).map((goal) => goal.label);
  return (
    <dl className="mxo-card mxo-gs__summary">
      <div>
        <dt>Using it for</dt>
        <dd>{goals.length > 0 ? goals.join(", ") : "Exploring"}</dd>
      </div>
      <div>
        <dt>Your AI</dt>
        <dd>Matrix</dd>
      </div>
    </dl>
  );
}

function stepTitle(wizard: GetStartedWizardState): string {
  const name = wizard.name.trim();
  switch (wizard.step) {
    case "name": return "What should we call you?";
    case "goals": return "What will you use Matrix for?";
    case "tools": return "Which tools do you use?";
    case "summary": return name ? `All set, ${name}.` : "All set.";
  }
}

function stepHint(wizard: GetStartedWizardState): string {
  switch (wizard.step) {
    case "name": return "Your AI will use this.";
    case "goals": return "Pick any. We'll set up those first.";
    case "tools": return "Nothing connects yet. This tells us what to set up first.";
    case "summary": return "You can change any of this later.";
  }
}

/** Tab stays inside the card and Escape never dismisses it: the wizard ends only by finishing or skipping. */
function trapKeys(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE));
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function GetStartedWizard({ wizard, submitting, error, dispatch, onFinish, onSkipAll, connect = null }: GetStartedWizardProps) {
  const titleId = useId();
  const hintId = useId();
  const focusTarget = useRef<HTMLElement | null>(null);
  const progress = getStartedQuestionProgress(wizard);
  const isSummary = wizard.step === "summary";
  const pickedGoals = new Set(wizard.goals);
  const answers = useMemo(() => getStartedAnswersFromWizard(wizard), [wizard]);

  // Each step change moves focus to its field, or its heading, for keyboard and screen reader users.
  useEffect(() => {
    focusTarget.current?.focus();
  }, [wizard.step]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={hintId}
      className="mxo-gs__card"
      onKeyDown={trapKeys}
    >
      <header className="mxo-gs__header">
        <span className="mxo-gs__brand"><RabbitAvatar size={22} />Matrix</span>
        <ol className="mxo-gs__progress" aria-label={`Question ${Math.min(progress.current + 1, progress.total)} of ${progress.total}`}>
          {Array.from({ length: progress.total }, (_, index) => (
            <li key={index} data-done={index <= progress.current ? "" : undefined} />
          ))}
        </ol>
      </header>

      <div className="mxo-gs__body">
        <h2
          id={titleId}
          className="mxo-gs__title"
          tabIndex={-1}
          ref={wizard.step === "name" ? undefined : (node) => { focusTarget.current = node; }}
        >
          {stepTitle(wizard)}
        </h2>
        <p id={hintId} className="mxo-muted mxo-gs__hint">{stepHint(wizard)}</p>

        {wizard.step === "name" ? (
          <input
            ref={(node) => { focusTarget.current = node; }}
            className="mxo-gs__input"
            placeholder="Your first name"
            aria-labelledby={titleId}
            autoComplete="given-name"
            value={wizard.name}
            onChange={(event) => dispatch({ type: "name", value: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") dispatch({ type: "next" });
            }}
          />
        ) : null}

        {wizard.step === "goals" ? (
          <div className="mxo-chips" role="group" aria-labelledby={titleId}>
            {GET_STARTED_GOALS.map((goal) => (
              <ToggleChip key={goal.id} label={goal.label} pressed={pickedGoals.has(goal.id)} onToggle={() => dispatch({ type: "toggle-goal", goal: goal.id })} />
            ))}
          </div>
        ) : null}

        {wizard.step === "tools" ? (
          <div className="mxo-gs__groups">
            {getStartedToolGroupsForGoals(wizard.goals).map((group) => (
              <ChoiceGroup key={group.goal} group={group} wizard={wizard} dispatch={dispatch} />
            ))}
          </div>
        ) : null}

        {isSummary ? <Summary wizard={wizard} /> : null}
        {isSummary && connect ? <GetStartedConnectList answers={answers} connect={connect} /> : null}

        {error ? <p className="mxo-failed-line" role="alert">{error}</p> : null}
      </div>

      <footer className="mxo-gs__footer">
        {wizard.step === "name" ? (
          <button type="button" className="mxo-link" onClick={onSkipAll} disabled={submitting}>Skip setup</button>
        ) : (
          <button type="button" className="mxo-btn mxo-btn--ghost" onClick={() => dispatch({ type: "back" })} disabled={submitting}>Back</button>
        )}
        <ButtonRow>
          {isSummary ? (
            <button type="button" className="mxo-btn mxo-btn--dark" onClick={onFinish} disabled={submitting} aria-busy={submitting}>
              Enter your computer
            </button>
          ) : (
            <>
              <button type="button" className="mxo-btn mxo-btn--ghost" onClick={() => dispatch({ type: "skip" })}>Skip</button>
              <button type="button" className="mxo-btn mxo-btn--dark" onClick={() => dispatch({ type: "next" })}>
                {wizard.step === "tools" ? "Finish" : "Next"}
              </button>
            </>
          )}
        </ButtonRow>
      </footer>
    </div>
  );
}

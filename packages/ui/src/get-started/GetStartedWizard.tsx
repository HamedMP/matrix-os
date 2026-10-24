import {
  GET_STARTED_GOALS,
  GET_STARTED_PERSONALITIES,
  getStartedAnswersFromWizard,
  getStartedBotFromWizard,
  getStartedQuestionProgress,
  getStartedToolGroupsForGoals,
  type GetStartedChoiceGroup,
  type GetStartedWizardEvent,
  type GetStartedWizardState,
  type GetStartedWizardStep,
} from "@matrix-os/contracts";
import { useEffect, useId, useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";
import { ButtonRow, RabbitAvatar, ToggleChip } from "../onboarding-widget/parts.js";
import { GetStartedAiStep } from "./ai-step.js";
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

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

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

/** The AI as finishing saves it, so a blank name shows as Matrix, like the saved one. */
function yourAi(wizard: GetStartedWizardState): string {
  const bot = wizard.botChosen ? getStartedBotFromWizard(wizard.bot) : null;
  if (!bot) return "Matrix";
  return `${bot.name} · ${GET_STARTED_PERSONALITIES.find((personality) => personality.id === bot.personality)?.label ?? ""}`;
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
        <dd>{yourAi(wizard)}</dd>
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
    case "ai": return "Give your AI a name";
    case "summary": return name ? `All set, ${name}.` : "All set.";
  }
}

function stepHint(wizard: GetStartedWizardState): string {
  switch (wizard.step) {
    case "name": return "Your AI will use this.";
    case "goals": return "Pick any. We'll set up those first.";
    case "tools": return "Nothing connects yet. This tells us what to set up first.";
    case "ai": return "It uses this name and style everywhere you talk to Matrix.";
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
  // The step heading takes focus but is not tabbable, so it counts as "before the first control".
  const index = focusable.indexOf(document.activeElement as HTMLElement);
  if (event.shiftKey && index <= 0) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && index === focusable.length - 1) {
    event.preventDefault();
    first.focus();
  }
}

/** Says why the wizard can't end yet: Enter your computer and Skip setup wait for an app sign-in. */
function SignInPending({ connect, step }: { connect: GetStartedConnect | null; step: GetStartedWizardStep }) {
  if (!connect?.connectingService || (step !== "summary" && step !== "name")) return null;
  return <p className="mxo-muted" role="status">Waiting for your app sign-in to finish.</p>;
}

export function GetStartedWizard({ wizard, submitting, error, dispatch, onFinish, onSkipAll, connect = null }: GetStartedWizardProps) {
  const titleId = useId();
  const hintId = useId();
  const focusTarget = useRef<HTMLElement | null>(null);
  const progress = getStartedQuestionProgress(wizard);
  const isSummary = wizard.step === "summary";
  // Ending the wizard unmounts its connector, which would drop an app sign-in still under way.
  const endBlocked = submitting || Boolean(connect?.connectingService);
  const pickedGoals = new Set(wizard.goals);
  const answers = useMemo(() => getStartedAnswersFromWizard(wizard), [wizard]);
  // A name bot creation would reject cannot be confirmed; the AI step explains why.
  const botNameInvalid = wizard.step === "ai" && getStartedBotFromWizard(wizard.bot) === null;

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
              if (event.key === "Enter" && !event.nativeEvent.isComposing) dispatch({ type: "next" });
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

        {wizard.step === "ai" ? <GetStartedAiStep bot={wizard.bot} answers={answers} dispatch={dispatch} /> : null}

        {isSummary ? <Summary wizard={wizard} /> : null}
        {isSummary && connect ? <GetStartedConnectList answers={answers} connect={connect} /> : null}

        {error ? <p className="mxo-failed-line" role="alert">{error}</p> : null}
        <SignInPending connect={connect} step={wizard.step} />
      </div>

      <footer className="mxo-gs__footer">
        {wizard.step === "name" ? (
          <button type="button" className="mxo-link" onClick={onSkipAll} disabled={endBlocked}>Skip setup</button>
        ) : (
          <button type="button" className="mxo-btn mxo-btn--ghost" onClick={() => dispatch({ type: "back" })} disabled={submitting}>Back</button>
        )}
        <ButtonRow>
          {isSummary ? (
            <button type="button" className="mxo-btn mxo-btn--dark" onClick={onFinish} disabled={endBlocked} aria-busy={submitting}>
              Enter your computer
            </button>
          ) : (
            <>
              <button type="button" className="mxo-btn mxo-btn--ghost" onClick={() => dispatch({ type: "skip" })}>Skip</button>
              <button type="button" className="mxo-btn mxo-btn--dark" disabled={botNameInvalid} onClick={() => dispatch({ type: "next" })}>
                {wizard.step === "ai" ? "Finish" : "Next"}
              </button>
            </>
          )}
        </ButtonRow>
      </footer>
    </div>
  );
}

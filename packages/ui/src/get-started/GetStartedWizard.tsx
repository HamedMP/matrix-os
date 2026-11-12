import {
  GET_STARTED_GOALS,
  GET_STARTED_PERSONALITIES,
  GET_STARTED_RECIPE_BOTS,
  getStartedAnswersFromWizard,
  getStartedBotFromWizard,
  getStartedQuestionProgress,
  getStartedToolGroupsForGoals,
  type GetStartedAgentKind,
  type GetStartedAnswers,
  type GetStartedChoiceGroup,
  type GetStartedWizardEvent,
  type GetStartedWizardState,
  type GetStartedWizardStep,
} from "@matrix-os/contracts";
import { galleryAppsReadyWith } from "@matrix-os/contracts/app-gallery";
import { useCallback, useEffect, useId, useMemo, useRef, type KeyboardEvent } from "react";
import { ButtonRow, RabbitAvatar, ToggleChip } from "../onboarding-widget/parts.js";
import { GetStartedAiStep } from "./ai-step.js";
import { GetStartedAppGalleryStep, type GetStartedReadyApp } from "./app-gallery-step.js";
import type { GetStartedAgentLoginHost } from "./agent-login.js";
import { GetStartedAgentsStep } from "./agents-step.js";
import { GetStartedConnectTools, type GetStartedConnect } from "./connect.js";
import { joinNames, type GetStartedGallery } from "./gallery.js";
import { GetStartedRecipeBots } from "./recipe-bots.js";
import type { GetStartedPort } from "./use-get-started.js";

export interface GetStartedWizardProps {
  wizard: GetStartedWizardState;
  submitting: boolean;
  error: string | null;
  dispatch(event: GetStartedWizardEvent): void;
  onFinish(): void;
  onSkipAll(): void;
  /** App connections for step 3 and the bots; absent when the surface cannot connect apps. */
  connect?: GetStartedConnect | null;
  /** App Gallery for step 5; absent when the surface has none. */
  gallery?: GetStartedGallery | null;
  /** The surface's Settings > Agents & providers host for the coding agents screen; absent when it has none. */
  agentLogin?: GetStartedAgentLoginHost | null;
  /** The surface's bot name suggestions for the AI step; absent means built-in names only. */
  suggestBotNames?: GetStartedPort["suggestBotNames"] | null;
}

/** App Gallery apps the owner's current connections make ready. */
function useReadyApps(gallery: GetStartedGallery | null, connect: GetStartedConnect | null): GetStartedReadyApp[] {
  return useMemo(
    () => (gallery && connect ? galleryAppsReadyWith(gallery.apps, connect.connectedServices) : []),
    [gallery, connect],
  );
}

/** Reports live connections once read, so the connected integrations become the owner's tools. */
function useReportConnections(connect: GetStartedConnect | null, dispatch: (event: GetStartedWizardEvent) => void): void {
  const loaded = connect?.connectionsLoaded === true;
  const services = loaded ? [...connect.connectedServices].sort().join(",") : "";
  useEffect(() => {
    // Unread connections are unknown, not empty: the saved tools stand until they are read.
    if (loaded) dispatch({ type: "connected", services: services ? services.split(",") : [] });
  }, [loaded, services, dispatch]);
}

/** The services the ready apps use, in the order they first appear. */
function readyServiceNames(ready: readonly GetStartedReadyApp[]): string[] {
  return [...new Set(ready.flatMap((entry) => entry.using.map((service) => service.name)))];
}

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

function ChoiceGroup({ group, wizard, dispatch }: {
  group: GetStartedChoiceGroup;
  wizard: GetStartedWizardState;
  dispatch(event: GetStartedWizardEvent): void;
}) {
  const titleId = useId();
  return (
    <section className="mxo-gs__group" aria-labelledby={titleId}>
      <h3 id={titleId} className="mxo-muted">{group.title}</h3>
      <div className="mxo-chips">
        {group.options.map((starter) => (
          <ToggleChip key={starter.id} label={starter.label} pressed={wizard.starter === starter.id} onToggle={() => dispatch({ type: "pick-starter", id: starter.id })} />
        ))}
      </div>
    </section>
  );
}

/** The coding agents screen through the surface's provider host, reporting connected agents as answers. */
function AgentsStep({ agentLogin: AgentLogin, dispatch }: { agentLogin: GetStartedAgentLoginHost | null; dispatch(event: GetStartedWizardEvent): void }) {
  const onAgentsConnected = useCallback((agents: GetStartedAgentKind[]) => dispatch({ type: "agents-connected", agents }), [dispatch]);
  if (!AgentLogin) return <p className="mxo-muted">You can sign in to Claude Code or Codex later in Settings &gt; Agents &amp; providers.</p>;
  return <AgentLogin>{(port) => <GetStartedAgentsStep port={port} onAgentsConnected={onAgentsConnected} />}</AgentLogin>;
}

/** The AI as finishing saves it, so a blank name shows as Matrix, like the saved one. */
function yourAi(wizard: GetStartedWizardState): string {
  const bot = wizard.botChosen ? getStartedBotFromWizard(wizard.bot) : null;
  if (!bot) return "Matrix";
  return `${bot.name} · ${GET_STARTED_PERSONALITIES.find((personality) => personality.id === bot.personality)?.label ?? ""}`;
}

function Summary({ wizard, answers }: { wizard: GetStartedWizardState; answers: GetStartedAnswers }) {
  const picked = new Set(wizard.goals);
  const goals = GET_STARTED_GOALS.filter((goal) => picked.has(goal.id)).map((goal) => goal.label);
  const addedBots = new Set(answers.bots ?? []);
  const bots = GET_STARTED_RECIPE_BOTS.filter((bot) => addedBots.has(bot.recipeId)).map((bot) => bot.label);
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
      <div>
        <dt>Your bots</dt>
        <dd>{bots.length > 0 ? bots.join(", ") : "None yet"}</dd>
      </div>
    </dl>
  );
}

function stepTitle(wizard: GetStartedWizardState, ready: readonly GetStartedReadyApp[]): string {
  const name = wizard.name.trim();
  switch (wizard.step) {
    case "name": return "What should we call you?";
    case "goals": return "What will you use Matrix for?";
    case "agents": return "Sign in to your coding agents";
    case "tools": return "Connect the tools you use";
    case "ai": return "Name your main bot";
    case "gallery": return ready.length > 0 ? "Apps that work with your tools" : "Build your own apps";
    case "bots": return "Meet your bots";
    case "summary": return name ? `All set, ${name}.` : "All set.";
  }
}

function stepHint(wizard: GetStartedWizardState, ready: readonly GetStartedReadyApp[]): string {
  switch (wizard.step) {
    case "name": return "Your AI will use this.";
    case "goals": return "Pick any. We'll set up those first.";
    case "agents": return "Have a Claude or ChatGPT plan? Sign in to use it in Matrix. You can skip this and do it later in Settings.";
    case "tools": return "Each one opens the app's own sign-in. Connect any now, or later in Settings.";
    case "ai": return "This is your main bot. It uses this name and style everywhere you talk to Matrix.";
    case "gallery": return ready.length > 0
      // ENG-391: apps install empty and fill up only after an import, so never say they hold the data yet.
      ? `These apps work with ${joinNames(readyServiceNames(ready))}. Add one, then import your data from inside it.`
      : "Describe an app and Matrix builds it for you to keep and use. Pick one to start with.";
    case "bots": return "Bots are AI teammates that each do one job for you. Add any you like.";
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

/** The questions after the name: one body per step, under the shared heading. */
function StepContent({ wizard, answers, connect, gallery, ready, agentLogin, suggestBotNames, dispatch, titleId }: {
  wizard: GetStartedWizardState;
  answers: GetStartedAnswers;
  connect: GetStartedConnect | null;
  agentLogin: GetStartedAgentLoginHost | null;
  suggestBotNames: GetStartedPort["suggestBotNames"] | null;
  gallery: GetStartedGallery | null;
  ready: readonly GetStartedReadyApp[];
  dispatch(event: GetStartedWizardEvent): void;
  titleId: string;
}) {
  switch (wizard.step) {
    case "name": return null;
    case "goals": {
      const pickedGoals = new Set(wizard.goals);
      return (
        <div className="mxo-chips" role="group" aria-labelledby={titleId}>
          {GET_STARTED_GOALS.map((goal) => (
            <ToggleChip key={goal.id} label={goal.label} pressed={pickedGoals.has(goal.id)} onToggle={() => dispatch({ type: "toggle-goal", goal: goal.id })} />
          ))}
        </div>
      );
    }
    case "agents": return <AgentsStep agentLogin={agentLogin} dispatch={dispatch} />;
    case "tools": return (
      <div className="mxo-gs__groups">
        {getStartedToolGroupsForGoals(wizard.goals).map((group) => (
          <ChoiceGroup key={group.goal} group={group} wizard={wizard} dispatch={dispatch} />
        ))}
        <GetStartedConnectTools goals={wizard.goals} connect={connect} />
      </div>
    );
    case "ai": return <GetStartedAiStep bot={wizard.bot} answers={answers} dispatch={dispatch} suggestBotNames={suggestBotNames} />;
    case "gallery": return <GetStartedAppGalleryStep wizard={wizard} dispatch={dispatch} labelledBy={titleId} gallery={gallery} ready={ready} />;
    case "bots": return <GetStartedRecipeBots wizard={wizard} connect={connect} dispatch={dispatch} />;
    case "summary": return <Summary wizard={wizard} answers={answers} />;
  }
}

export function GetStartedWizard({ wizard, submitting, error, dispatch, onFinish, onSkipAll, connect = null, gallery = null, agentLogin = null, suggestBotNames = null }: GetStartedWizardProps) {
  const titleId = useId();
  const hintId = useId();
  const focusTarget = useRef<HTMLElement | null>(null);
  const progress = getStartedQuestionProgress(wizard);
  const isSummary = wizard.step === "summary";
  // Ending the wizard unmounts its connector, which would drop an app sign-in still under way.
  const endBlocked = submitting || Boolean(connect?.connectingService);
  const answers = useMemo(() => getStartedAnswersFromWizard(wizard), [wizard]);
  // A name bot creation would reject cannot be confirmed; the AI step explains why.
  const botNameInvalid = wizard.step === "ai" && getStartedBotFromWizard(wizard.bot) === null;
  const ready = useReadyApps(gallery, connect);
  useReportConnections(connect, dispatch);
  // An app still being added keeps the owner here, so a failure and its retry are never missed.
  const leaving = submitting || (wizard.step === "gallery" && Boolean(gallery?.installing));

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
          {stepTitle(wizard, ready)}
        </h2>
        <p id={hintId} className="mxo-muted mxo-gs__hint">{stepHint(wizard, ready)}</p>

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

        <StepContent wizard={wizard} answers={answers} connect={connect} gallery={gallery} ready={ready} agentLogin={agentLogin} suggestBotNames={suggestBotNames} dispatch={dispatch} titleId={titleId} />

        {error ? <p className="mxo-failed-line" role="alert">{error}</p> : null}
        <SignInPending connect={connect} step={wizard.step} />
      </div>

      <footer className="mxo-gs__footer">
        {wizard.step === "name" ? (
          <button type="button" className="mxo-link" onClick={onSkipAll} disabled={endBlocked}>Skip setup</button>
        ) : (
          <button type="button" className="mxo-btn mxo-btn--ghost" onClick={() => dispatch({ type: "back" })} disabled={leaving}>Back</button>
        )}
        <ButtonRow>
          {isSummary ? (
            <button type="button" className="mxo-btn mxo-btn--dark" onClick={onFinish} disabled={endBlocked} aria-busy={submitting}>
              Enter your computer
            </button>
          ) : (
            <>
              <button type="button" className="mxo-btn mxo-btn--ghost" disabled={leaving} onClick={() => dispatch({ type: "skip" })}>Skip</button>
              <button type="button" className="mxo-btn mxo-btn--dark" disabled={botNameInvalid || leaving} onClick={() => dispatch({ type: "next" })}>
                {wizard.step === "bots" ? "Finish" : "Next"}
              </button>
            </>
          )}
        </ButtonRow>
      </footer>
    </div>
  );
}

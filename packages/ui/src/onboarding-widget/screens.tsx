import {
  ONBOARDING_REPO_QUESTION,
  ONBOARDING_TASKS,
  orderByIds,
  onboardingFollowUpPrompt,
  onboardingRunTitle,
  onboardingWorkingLine,
  onboardingTask,
  type OnboardingAiChoice,
  type OnboardingConnectStatus,
  type OnboardingRequiredService,
  type OnboardingRunScreen,
  type OnboardingTaskDefinition,
  type OnboardingWidgetState,
  type OnboardingWorkStep,
} from "@matrix-os/contracts";
import {
  Alert02Icon,
  FolderOpenIcon,
  GithubIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { useMemo, useState } from "react";
import { connectedServices, newlyConnectedNames } from "./helpers.js";
import { AppLogo, ButtonRow, Chips, Icon, OnboardingTaskButton, ResultCard, WorkLog } from "./parts.js";
import { ONBOARDING_TASK_ICONS } from "./task-icons.js";
import type { OnboardingAppCategory, OnboardingWidgetProps } from "./types.js";

const TASK_ICONS = ONBOARDING_TASK_ICONS;

export function TasksScreen({ state, apps, appsUnavailable = false, userName, taskOrder, intro, buildSuggestion, actions }: Pick<OnboardingWidgetProps, "state" | "apps" | "appsUnavailable" | "userName" | "taskOrder" | "intro" | "buildSuggestion" | "actions">) {
  const connected = connectedServices(apps);
  const tasks = useMemo(() => (taskOrder ? orderByIds(ONBOARDING_TASKS, taskOrder) : ONBOARDING_TASKS), [taskOrder]);
  const connectedSet = new Set(connected);
  const firstVisit = !state.started && !state.echo && !state.notice;
  return (
    <>
      {firstVisit ? (
        <>
          <p className="mxo-greeting">{userName ? `Hey ${userName} 👋` : "Hey 👋"}</p>
          {intro ? <p className="mxo-text">{intro}</p> : <p className="mxo-text">I'm Matrix. I work in your apps, even while you're away.<br />What should I start on?</p>}
        </>
      ) : (
        <p className="mxo-text">What should I start on?</p>
      )}
      <ul className="mxo-card mxo-tasks" aria-label="Tasks">
        {buildSuggestion ? (
          <li>
            <button
              type="button"
              className="mxo-task"
              onClick={() => actions.dispatch({ type: "build.requested", title: buildSuggestion.title, prompt: buildSuggestion.prompt })}
            >
              <span className="mxo-tile mxo-tile--website"><Icon icon={TASK_ICONS.website} size={16} /></span>
              <span className="mxo-task__label">Build a {buildSuggestion.title.toLowerCase()}</span>
            </button>
          </li>
        ) : null}
        {tasks.map((task) => {
          const needsTag = task.needs && !connectedSet.has(task.needs.service) ? task.needs.tag : null;
          return (
            <li key={task.id}>
              <OnboardingTaskButton
                task={task}
                needsTag={needsTag}
                onSelect={() => actions.dispatch({
                  type: "task.selected",
                  taskId: task.id,
                  connectedServices: connected,
                  ...(appsUnavailable ? { appsUnavailable: true } : {}),
                })}
              />
            </li>
          );
        })}
      </ul>
      {appsUnavailable ? null : (
        <button type="button" className="mxo-link" onClick={() => actions.dispatch({ type: "apps.opened" })}>
          Connect apps first
        </button>
      )}
    </>
  );
}

const APP_FILTERS: { id: OnboardingAppCategory | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "work", label: "Work" },
  { id: "personal", label: "Personal" },
  { id: "dev", label: "Dev" },
];

export function AppsScreen({ apps, actions, query, onQuery, connectedBefore }: Pick<OnboardingWidgetProps, "apps" | "actions"> & {
  query: string;
  onQuery(query: string): void;
  /** Apps already connected when this visit started, so Done names only new connections. */
  connectedBefore: readonly string[];
}) {
  const [filter, setFilter] = useState<OnboardingAppCategory | "all">("all");
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return apps.filter((app) => (filter === "all" || app.category === filter) && (!needle || app.name.toLocaleLowerCase().includes(needle)));
  }, [apps, filter, query]);
  const connectedNames = newlyConnectedNames(apps, connectedBefore);
  return (
    <>
      <p className="mxo-text">Connect the apps you use.</p>
      <div className="mxo-card mxo-apps">
        <label className="mxo-search">
          <Icon icon={Search01Icon} size={14} />
          <input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Search apps" aria-label="Search apps" maxLength={80} />
        </label>
        <div className="mxo-filters" role="group" aria-label="Filter apps">
          {APP_FILTERS.map((item) => (
            <button key={item.id} type="button" aria-pressed={filter === item.id} className="mxo-filter" onClick={() => setFilter(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
        <ul className="mxo-app-list">
          {visible.map((app) => (
            <li key={app.id} className="mxo-app">
              <AppLogo src={app.logoUrl} name={app.name} />
              <span className="mxo-app__name">{app.name}</span>
              {app.status === "connected" ? (
                <span className="mxo-connected"><span className="mxo-dot mxo-dot--working" aria-hidden />Connected</span>
              ) : (
                <button type="button" className="mxo-btn mxo-btn--outline" disabled={app.status === "connecting"} onClick={() => actions.connectApp(app.id)}>
                  {app.status === "connecting" ? "Connecting…" : "Connect"}
                </button>
              )}
            </li>
          ))}
          {visible.length === 0 ? (
            <li className="mxo-app-empty">
              <span className="mxo-tile mxo-tile--neutral"><Icon icon={Search01Icon} size={16} /></span>
              <span className="mxo-result__title">No apps match</span>
              <span className="mxo-muted">Try another name or filter.</span>
              <button type="button" className="mxo-link" onClick={() => { onQuery(""); setFilter("all"); }}>Clear search</button>
            </li>
          ) : null}
        </ul>
      </div>
      <ButtonRow>
        <button type="button" className="mxo-btn mxo-btn--dark" onClick={() => actions.dispatch({ type: "apps.closed", connectedNames })}>Done</button>
      </ButtonRow>
    </>
  );
}

export function QuestionScreen({ taskId, actions }: { taskId: OnboardingTaskDefinition["id"]; actions: OnboardingWidgetProps["actions"] }) {
  const question = onboardingTask(taskId)?.question;
  if (!question) return null;
  return (
    <>
      <p className="mxo-text">{question.text}</p>
      <Chips chips={question.chips} onPick={(chip) => actions.dispatch({ type: "answer.submitted", text: chip })} />
    </>
  );
}

function ConnectStatusLine({ status, access }: { status: OnboardingConnectStatus; access: string }) {
  if (status === "failed") return <span className="mxo-failed-line"><Icon icon={Alert02Icon} size={12} />Sign-in didn't finish</span>;
  if (status === "unavailable") return <span className="mxo-muted">App connections aren't available on this computer</span>;
  return <span className="mxo-muted">{access}</span>;
}

export function ConnectScreen({ taskId, status, apps, actions }: { taskId: OnboardingTaskDefinition["id"]; status: OnboardingConnectStatus } & Pick<OnboardingWidgetProps, "apps" | "actions">) {
  const needs = onboardingTask(taskId)?.needs;
  if (!needs) return null;
  const app = apps.find((candidate) => candidate.id === needs.service);
  const unavailable = status === "unavailable";
  return (
    <>
      <p className="mxo-text">{needs.ask}</p>
      <div className="mxo-card mxo-connect">
        <div className="mxo-connect__row">
          <AppLogo src={app?.logoUrl} name={needs.name} size={32} />
          <span className="mxo-result__text">
            <span className="mxo-result__title">{needs.name}</span>
            <ConnectStatusLine status={status} access={needs.access} />
          </span>
        </div>
        <ButtonRow>
          {unavailable ? null : (
            <button type="button" className="mxo-btn mxo-btn--dark" disabled={status === "connecting"} onClick={() => actions.connectApp(needs.service)}>
              {status === "connecting" ? "Connecting…" : status === "failed" ? "Try again" : "Connect"}
            </button>
          )}
          <button type="button" className={`mxo-btn ${unavailable ? "mxo-btn--dark" : "mxo-btn--ghost"}`} onClick={() => actions.dispatch({ type: "connect.skipped" })}>Skip</button>
        </ButtonRow>
      </div>
    </>
  );
}

export function RepoScreen({ repos, actions }: Pick<OnboardingWidgetProps, "repos" | "actions">) {
  return (
    <>
      <p className="mxo-text">{ONBOARDING_REPO_QUESTION.text}</p>
      {repos === null ? <p className="mxo-muted">Loading repos…</p> : null}
      {repos?.length === 0 ? (
        <div className="mxo-card mxo-empty">
          <span className="mxo-tile mxo-tile--neutral"><Icon icon={GithubIcon} size={16} /></span>
          <span className="mxo-result__title">No repos found</span>
          <span className="mxo-muted">Paste a repo link below to work on it.</span>
        </div>
      ) : null}
      {repos && repos.length > 0 ? (
        <div className="mxo-card mxo-tasks">
          {repos.map((repo) => (
            <button
              key={repo.url}
              type="button"
              className="mxo-task"
              onClick={() => actions.dispatch({ type: "answer.submitted", text: repo.name, context: repo.url })}
            >
              <span className="mxo-tile mxo-tile--neutral"><Icon icon={FolderOpenIcon} size={16} /></span>
              <span className="mxo-result__text">
                <span className="mxo-result__title">{repo.name}</span>
                {repo.updatedLabel ? <span className="mxo-muted">{repo.updatedLabel}</span> : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

const CODE_AGENT_LABELS: Record<OnboardingAiChoice, string> = { matrix: "Matrix AI", claude: "Claude Code", codex: "Codex" };

type RunActions = OnboardingWidgetProps["actions"];

function WaitingForComputer() {
  return (
    <>
      <p className="mxo-text">Got it. I'll start once your computer is ready.</p>
      <div className="mxo-card mxo-starting">
        <span className="mxo-starting__row">
          <span className="mxo-result__title">Starting your computer</span>
          <span className="mxo-muted">~1 min</span>
        </span>
        <span className="mxo-progress" aria-hidden><span /></span>
      </div>
    </>
  );
}

function RunFailed({ steps, failedStep, actions }: { steps: readonly OnboardingWorkStep[]; failedStep: string; actions: RunActions }) {
  return (
    <>
      <WorkLog steps={steps.length > 0 ? steps : [{ id: "run-failed", label: failedStep, state: "failed" }]} />
      <p className="mxo-text">I couldn't finish this one.</p>
      <div className="mxo-chips">
        <button type="button" className="mxo-chip" onClick={() => actions.dispatch({ type: "run.retried", simpler: false })}>Try again</button>
        <button type="button" className="mxo-chip" onClick={() => actions.dispatch({ type: "run.retried", simpler: true })}>Try a simpler version</button>
      </div>
    </>
  );
}

function CreditsOffer({ actions }: { actions: RunActions }) {
  return (
    <>
      <p className="mxo-text">You've used your free credits.</p>
      <div className="mxo-stack">
        <button type="button" className="mxo-btn mxo-btn--dark mxo-btn--block" onClick={actions.addCredits}>Add credits</button>
        <button type="button" className="mxo-btn mxo-btn--outline mxo-btn--block" data-mxo-menu-toggle="ai" onClick={() => actions.dispatch({ type: "ai.menuToggled" })}>Use my Claude or ChatGPT</button>
      </div>
    </>
  );
}

function FollowUpOffer({ run, followUp, aiChoice, actions }: {
  run: OnboardingRunScreen;
  followUp: OnboardingTaskDefinition["followUp"];
  aiChoice: OnboardingAiChoice | null;
  actions: RunActions;
}) {
  return (
    <>
      {followUp.question ? <p className="mxo-text">{followUp.question}</p> : null}
      <Chips
        chips={followUp.chips}
        onPick={(choice) => actions.dispatch({ type: "followUp.chosen", choice, prompt: onboardingFollowUpPrompt(run.taskId, choice, run.answer) })}
      />
      {/* The follow-up stays on its chat's AI, so this names it and offers no Change. */}
      {run.taskId === "work-on-code" && aiChoice ? <p className="mxo-model-line">Using {CODE_AGENT_LABELS[aiChoice]}</p> : null}
    </>
  );
}

type RunScreenProps = { run: OnboardingRunScreen; state: OnboardingWidgetState; followUpAi: OnboardingAiChoice | null } & Pick<OnboardingWidgetProps, "runView" | "creditsExhausted" | "actions">;

export function RunScreen(props: RunScreenProps) {
  const { run, runView, actions } = props;
  const steps = runView?.steps ?? [];
  if (run.phase === "waiting_computer") return <WaitingForComputer />;
  if (run.phase === "failed") return <RunFailed steps={steps} failedStep={onboardingTask(run.taskId)?.failedStep ?? "Couldn't finish this"} actions={actions} />;
  if (run.phase === "done") return <RunDone {...props} />;
  const label = run.taskId === "custom" ? "Working on it" : onboardingWorkingLine(run.taskId, run.answer);
  const log = <WorkLog steps={steps.length > 0 ? steps : [{ id: "run-working", label, state: "running" }]} />;
  if (runView?.status !== "waiting") return log;
  return (
    <>
      {log}
      <p className="mxo-text">I need your OK to keep going.</p>
      <ButtonRow>
        <button type="button" className="mxo-btn mxo-btn--dark" onClick={actions.openFullChat}>Open in chat</button>
      </ButtonRow>
    </>
  );
}

function RunDone({ run, state, runView, creditsExhausted, followUpAi, actions }: RunScreenProps) {
  const task = onboardingTask(run.taskId);
  const steps = runView?.steps ?? [];
  const followUp = task && !state.followUpUsed && !creditsExhausted ? task.followUp : null;
  return (
    <>
      <WorkLog steps={steps} />
      {task?.readyLine ? <p className="mxo-text">{task.readyLine}</p> : null}
      {runView?.resultSummary
        ? <p className="mxo-text mxo-summary">{runView.resultSummary}</p>
        : task?.readyLine ? null : <p className="mxo-text">Done.</p>}
      <ResultCard title={onboardingRunTitle(run)} onOpen={actions.openResult} />
      {creditsExhausted ? <CreditsOffer actions={actions} /> : null}
      {followUp ? <FollowUpOffer run={run} followUp={followUp} aiChoice={followUpAi} actions={actions} /> : null}
    </>
  );
}

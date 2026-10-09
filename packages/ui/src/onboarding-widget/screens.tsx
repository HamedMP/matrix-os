import {
  ONBOARDING_REPO_QUESTION,
  ONBOARDING_TASKS,
  onboardingFollowUpPrompt,
  onboardingResultTitle,
  onboardingTask,
  type OnboardingAiChoice,
  type OnboardingRequiredService,
  type OnboardingRunScreen,
  type OnboardingTaskDefinition,
  type OnboardingWidgetState,
} from "@matrix-os/contracts";
import {
  Alert02Icon,
  Calendar03Icon,
  Folder01Icon,
  GithubIcon,
  Globe02Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { useMemo, useState } from "react";
import { AppLogo, ButtonRow, Chips, Icon, ResultCard, WorkLog } from "./parts.js";
import type { OnboardingAppCategory, OnboardingWidgetProps } from "./types.js";

const TASK_ICONS: Record<OnboardingTaskDefinition["tone"], IconSvgElement> = {
  research: Search01Icon,
  plan: Calendar03Icon,
  website: Globe02Icon,
  code: GithubIcon,
};

export function connectedServices(apps: OnboardingWidgetProps["apps"]): OnboardingRequiredService[] {
  return apps
    .filter((app) => app.status === "connected" && (app.id === "google_calendar" || app.id === "github"))
    .map((app) => app.id as OnboardingRequiredService);
}

export function TasksScreen({ state, apps, userName, actions }: Pick<OnboardingWidgetProps, "state" | "apps" | "userName" | "actions">) {
  const connected = connectedServices(apps);
  const firstVisit = !state.started && !state.echo && !state.notice;
  return (
    <>
      {firstVisit ? (
        <>
          <p className="mxo-greeting">{userName ? `Hey ${userName} 👋` : "Hey 👋"}</p>
          <p className="mxo-text">I'm Matrix. I work in your apps, even while you're away.<br />What should I start on?</p>
        </>
      ) : (
        <p className="mxo-text">What should I start on?</p>
      )}
      <ul className="mxo-card mxo-tasks" aria-label="Tasks">
        {ONBOARDING_TASKS.map((task) => {
          const needsTag = task.needs && !connected.includes(task.needs.service) ? task.needs.tag : null;
          return (
            <li key={task.id}>
              <button
                type="button"
                className="mxo-task"
                onClick={() => actions.dispatch({ type: "task.selected", taskId: task.id, connectedServices: connected })}
              >
                <span className={`mxo-tile mxo-tile--${task.tone}`}><Icon icon={TASK_ICONS[task.tone]} size={16} /></span>
                <span className="mxo-task__label">{task.label}</span>
                {needsTag ? <span className="mxo-tag">{needsTag}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
      <button type="button" className="mxo-link" onClick={() => actions.dispatch({ type: "apps.opened" })}>
        Connect apps first
      </button>
    </>
  );
}

const APP_FILTERS: { id: OnboardingAppCategory | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "work", label: "Work" },
  { id: "personal", label: "Personal" },
  { id: "dev", label: "Dev" },
];

export function AppsScreen({ apps, actions, query, onQuery }: Pick<OnboardingWidgetProps, "apps" | "actions"> & { query: string; onQuery(query: string): void }) {
  const [filter, setFilter] = useState<OnboardingAppCategory | "all">("all");
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return apps.filter((app) => (filter === "all" || app.category === filter) && (!needle || app.name.toLocaleLowerCase().includes(needle)));
  }, [apps, filter, query]);
  const connectedNames = apps.filter((app) => app.status === "connected").map((app) => app.name);
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
          {visible.length === 0 ? <li className="mxo-muted mxo-app-empty">No apps match.</li> : null}
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

export function ConnectScreen({ taskId, status, apps, actions }: { taskId: OnboardingTaskDefinition["id"]; status: "idle" | "connecting" | "failed" } & Pick<OnboardingWidgetProps, "apps" | "actions">) {
  const needs = onboardingTask(taskId)?.needs;
  if (!needs) return null;
  const app = apps.find((candidate) => candidate.id === needs.service);
  return (
    <>
      <p className="mxo-text">{needs.ask}</p>
      <div className="mxo-card mxo-connect">
        <div className="mxo-connect__row">
          <AppLogo src={app?.logoUrl} name={needs.name} size={32} />
          <span className="mxo-result__text">
            <span className="mxo-result__title">{needs.name}</span>
            {status === "failed" ? (
              <span className="mxo-failed-line"><Icon icon={Alert02Icon} size={12} />Sign-in didn't finish</span>
            ) : (
              <span className="mxo-muted">{needs.access}</span>
            )}
          </span>
        </div>
        <ButtonRow>
          <button type="button" className="mxo-btn mxo-btn--dark" disabled={status === "connecting"} onClick={() => actions.connectApp(needs.service)}>
            {status === "connecting" ? "Connecting…" : status === "failed" ? "Try again" : "Connect"}
          </button>
          <button type="button" className="mxo-btn mxo-btn--ghost" onClick={() => actions.dispatch({ type: "connect.skipped" })}>Skip</button>
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
      {repos && repos.length > 0 ? (
        <div className="mxo-card mxo-tasks">
          {repos.map((repo) => (
            <button
              key={repo.url}
              type="button"
              className="mxo-task"
              onClick={() => actions.dispatch({ type: "answer.submitted", text: repo.name, context: repo.url })}
            >
              <span className="mxo-tile mxo-tile--neutral"><Icon icon={Folder01Icon} size={16} /></span>
              <span className="mxo-task__label">{repo.name}</span>
              {repo.updatedLabel ? <span className="mxo-muted">{repo.updatedLabel}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

const CODE_AGENT_LABELS: Record<OnboardingAiChoice, string> = { matrix: "Matrix AI", claude: "Claude Code", codex: "Codex" };

export function RunScreen({ run, state, runView, creditsExhausted, actions }: { run: OnboardingRunScreen; state: OnboardingWidgetState } & Pick<OnboardingWidgetProps, "runView" | "creditsExhausted" | "actions">) {
  const task = onboardingTask(run.taskId);
  if (run.phase === "waiting_computer") {
    return (
      <>
        <p className="mxo-text">Got it. I'll start once your computer is ready.</p>
        <div className="mxo-card mxo-starting">
          <span className="mxo-result__title">Starting your computer</span>
          <span className="mxo-muted">~1 min</span>
          <span className="mxo-progress" aria-hidden><span /></span>
        </div>
      </>
    );
  }
  const steps = runView?.steps ?? [];
  if (run.phase === "failed") {
    return (
      <>
        <WorkLog steps={steps.length > 0 ? steps : [{ label: task?.failedStep ?? "Couldn't finish this", state: "failed" }]} />
        <p className="mxo-text">I couldn't finish this one.</p>
        <ButtonRow>
          <button type="button" className="mxo-btn mxo-btn--dark" onClick={() => actions.dispatch({ type: "run.retried", simpler: false })}>Try again</button>
          <button type="button" className="mxo-btn mxo-btn--outline" onClick={() => actions.dispatch({ type: "run.retried", simpler: true })}>Try a simpler version</button>
        </ButtonRow>
      </>
    );
  }
  if (run.phase !== "done") return <WorkLog steps={steps} />;
  const followUp = task?.followUp;
  return (
    <>
      <WorkLog steps={steps} />
      <p className="mxo-text">{task?.readyLine ?? runView?.resultSummary ?? "Done."}</p>
      {run.taskId !== "work-on-code" ? (
        <ResultCard title={onboardingResultTitle(run.taskId, run.answer)} subtitle={task ? runView?.resultSummary : undefined} onOpen={actions.openResult} />
      ) : null}
      {creditsExhausted ? (
        <>
          <p className="mxo-text">You've used your free credits.</p>
          <div className="mxo-stack">
            <button type="button" className="mxo-btn mxo-btn--dark mxo-btn--block" onClick={actions.addCredits}>Add credits</button>
            <button type="button" className="mxo-btn mxo-btn--outline mxo-btn--block" onClick={() => actions.dispatch({ type: "ai.menuToggled" })}>Use my Claude or ChatGPT</button>
          </div>
        </>
      ) : followUp && !state.followUpUsed ? (
        <>
          {followUp.question ? <p className="mxo-text">{followUp.question}</p> : null}
          <Chips
            chips={followUp.chips}
            onPick={(choice) => actions.dispatch({ type: "followUp.chosen", choice, prompt: onboardingFollowUpPrompt(run.taskId, choice, run.answer) })}
          />
          {run.taskId === "work-on-code" ? (
            <p className="mxo-model-line">
              Using {CODE_AGENT_LABELS[state.aiChoice]} · <button type="button" className="mxo-inline-link" onClick={() => actions.dispatch({ type: "ai.menuToggled" })}>Change</button>
            </p>
          ) : null}
        </>
      ) : null}
    </>
  );
}

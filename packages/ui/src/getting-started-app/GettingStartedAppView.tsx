/**
 * The Getting started app window (spec 639, Figma "🧭 Getting started"):
 * header with progress and points, a hero card, the task grid and a
 * support link. Shared by Web Desktop, Web Canvas and Electron Desktop.
 */
import {
  GETTING_STARTED_APP_TASK_IDS,
  gettingStartedAppNextTask,
  type GettingStartedAppTask,
  type GettingStartedAppTaskGroup,
  type GettingStartedAppTaskId,
} from "@matrix-os/contracts";
import { Bot, Check, Gift, Github, Hash, KeyRound, LayoutGrid, LifeBuoy, MessageCircle, Smartphone, Sparkles, Star, type LucideIcon } from "lucide-react";
import {
  GETTING_STARTED_APP_FIRST_PROMPT,
  gettingStartedAppAction,
  gettingStartedAppActionLabel,
  type GettingStartedAppAction,
} from "./actions.js";
import { GETTING_STARTED_APP_BRAND_VARS } from "./brand-vars.js";
import { useGettingStartedApp, type GettingStartedAppPoints } from "./provider.js";

const TASK_ICONS: Record<GettingStartedAppTaskId, LucideIcon> = {
  "first-prompt": Sparkles,
  "build-app": LayoutGrid,
  "create-agent": Bot,
  "build-memory": Sparkles,
  slack: Hash,
  whatsapp: MessageCircle,
  github: Github,
  "ai-provider": KeyRound,
  "mobile-app": Smartphone,
  "invite-friends": Gift,
};

const SECTIONS: ReadonlyArray<{ group: Exclude<GettingStartedAppTaskGroup, "hero">; title: string }> = [
  { group: "build", title: "Build" },
  { group: "connect", title: "Connect" },
  { group: "further", title: "Go further" },
];

const TOTAL_TASKS = GETTING_STARTED_APP_TASK_IDS.length;

export function GettingStartedAppView({ onAction }: { onAction(action: GettingStartedAppAction): void }) {
  const state = useGettingStartedApp();
  if (!state?.enabled) return null;
  const { tasks, doneCount, points, loaded } = state;
  const firstPrompt = tasks.find((task) => task.id === "first-prompt");
  const progress = Math.round((doneCount / TOTAL_TASKS) * 100);

  return (
    <div className="mxo-gsa" style={GETTING_STARTED_APP_BRAND_VARS} aria-busy={!loaded}>
      <div className="mxo-gsa__inner">
        <header className="mxo-gsa__header">
          <h1 className="mxo-gsa__title">Getting started</h1>
          <div className="mxo-gsa__progress">
            <span>{doneCount} of {TOTAL_TASKS} done</span>
            <span className="mxo-gsa__bar" role="progressbar" aria-label="Getting started progress" aria-valuemin={0} aria-valuemax={TOTAL_TASKS} aria-valuenow={doneCount}>
              <span className="mxo-gsa__bar-fill" style={{ width: `${progress}%` }} />
            </span>
            <PointsBadge points={points} />
          </div>
        </header>

        <Hero tasks={tasks} loaded={loaded} doneCount={doneCount} firstPrompt={firstPrompt} onAction={onAction} />

        {SECTIONS.map((section) => (
          <section key={section.group} className="mxo-gsa__section" aria-labelledby={`mxo-gsa-${section.group}`}>
            <h2 id={`mxo-gsa-${section.group}`} className="mxo-gsa__section-title">{section.title}</h2>
            <div className={`mxo-gsa__grid mxo-gsa__grid--${section.group}`}>
              {tasks.filter((task) => task.group === section.group).map((task) => (
                <TaskCard key={task.id} task={task} onAction={onAction} />
              ))}
            </div>
          </section>
        ))}

        <button type="button" className="mxo-gsa__support" onClick={() => onAction({ type: "support" })}>
          <LifeBuoy size={14} aria-hidden="true" />
          Stuck? Chat with us
        </button>
      </div>
    </div>
  );
}

function PointsBadge({ points }: { points: GettingStartedAppPoints }) {
  if (points.kind === "ready") {
    return (
      <span className="mxo-gsa__points" aria-label={`${points.total} points`}>
        <Star size={12} aria-hidden="true" />
        {points.total} pts
      </span>
    );
  }
  const label = points.kind === "unavailable" ? "Points unavailable" : "Loading points";
  return (
    <span className="mxo-gsa__points" aria-label={label}>
      <Star size={12} aria-hidden="true" />
      – pts
    </span>
  );
}

function Hero({
  tasks,
  loaded,
  doneCount,
  firstPrompt,
  onAction,
}: {
  tasks: GettingStartedAppTask[];
  loaded: boolean;
  doneCount: number;
  firstPrompt: GettingStartedAppTask | undefined;
  onAction(action: GettingStartedAppAction): void;
}) {
  if (!loaded) {
    return (
      <div className="mxo-gsa__hero">
        <div className="mxo-gsa__welcome">
          <span className="mxo-gsa__welcome-title">Welcome to Matrix</span>
          <span className="mxo-gsa__welcome-subtitle">Your AI computer</span>
        </div>
        <div className="mxo-gsa__next" role="status">
          <p className="mxo-gsa__next-description">Loading your tasks…</p>
        </div>
      </div>
    );
  }
  const startHere = firstPrompt?.status !== "complete";
  const next = startHere ? firstPrompt : gettingStartedAppNextTask(tasks);
  const action = next ? gettingStartedAppAction(next.id) : null;

  return (
    <div className="mxo-gsa__hero">
      <div className={`mxo-gsa__welcome${startHere ? "" : " mxo-gsa__welcome--compact"}`}>
        <span className="mxo-gsa__welcome-title">{startHere ? "Welcome to Matrix" : "Welcome back"}</span>
        <span className="mxo-gsa__welcome-subtitle">Your AI computer</span>
      </div>
      <div className="mxo-gsa__next">
        {next ? (
          <>
            <div className="mxo-gsa__chips">
              <span className="mxo-gsa__chip mxo-gsa__chip--label">{startHere ? "Start here" : "Up next"}</span>
              <span className="mxo-gsa__chip mxo-gsa__chip--points">+{next.points} pts</span>
            </div>
            <h2 className="mxo-gsa__next-title">{next.title}</h2>
            <p className="mxo-gsa__next-description">{next.description}</p>
            {startHere ? (
              <span className="mxo-gsa__prompt">
                <Sparkles size={12} aria-hidden="true" />
                “{GETTING_STARTED_APP_FIRST_PROMPT}”
              </span>
            ) : null}
            {action ? (
              <button type="button" className="mxo-gsa__primary" onClick={() => onAction(action)}>
                {gettingStartedAppActionLabel(next.id)}
              </button>
            ) : null}
          </>
        ) : doneCount === TOTAL_TASKS ? (
          <>
            <h2 className="mxo-gsa__next-title">You're all set</h2>
            <p className="mxo-gsa__next-description">Everything here is done. New ideas will show up as Matrix grows.</p>
          </>
        ) : (
          <>
            <h2 className="mxo-gsa__next-title">The rest can't be checked yet</h2>
            <p className="mxo-gsa__next-description">You can still try the remaining cards below. They'll show Done once Matrix can check them.</p>
          </>
        )}
      </div>
    </div>
  );
}

function TaskCard({ task, onAction }: { task: GettingStartedAppTask; onAction(action: GettingStartedAppAction): void }) {
  const Icon = TASK_ICONS[task.id];
  const action = gettingStartedAppAction(task.id);
  const done = task.status === "complete";
  return (
    <button
      type="button"
      className={`mxo-gsa__card${done ? " mxo-gsa__card--done" : ""}`}
      disabled={!action}
      onClick={action ? () => onAction(action) : undefined}
      title={task.status === "unavailable" && action ? "Status is temporarily unavailable" : undefined}
    >
      <span className="mxo-gsa__card-top">
        <span className="mxo-gsa__card-icon"><Icon size={16} aria-hidden="true" /></span>
        <TaskChip task={task} available={action !== null} />
      </span>
      <span className="mxo-gsa__card-title">{task.title}</span>
      <span className="mxo-gsa__card-description">{task.description}</span>
    </button>
  );
}

function TaskChip({ task, available }: { task: GettingStartedAppTask; available: boolean }) {
  if (!available) return <span className="mxo-gsa__chip">Coming soon</span>;
  if (task.status === "complete") {
    return (
      <span className="mxo-gsa__chip mxo-gsa__chip--done">
        <Check size={11} aria-hidden="true" />
        <span>Done</span>
      </span>
    );
  }
  if (task.status === "unavailable") return null;
  return <span className="mxo-gsa__chip mxo-gsa__chip--points">+{task.points} pts</span>;
}

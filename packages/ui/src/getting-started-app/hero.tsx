/**
 * The Getting started app's hero (spec 639): the Matrix agent and the right
 * panel. While the corner onboarding widget is open or busy, the panel mirrors
 * it instead of repeating its starter tasks; otherwise it lists them, then
 * shows Up next, and finally the Matrix unlocked banner.
 */
import {
  GETTING_STARTED_APP_TASK_IDS,
  ONBOARDING_TASKS,
  getStartedTaskOrder,
  gettingStartedAppAllChecked,
  gettingStartedAppNextTask,
  gettingStartedAppTask,
  orderByIds,
  type GettingStartedAppTask,
  type GettingStartedAppTaskId,
  type OnboardingStarterTaskId,
} from "@matrix-os/contracts";
import { Check, LoaderCircle, Sparkles, Star, TriangleAlert } from "lucide-react";
import { useMemo } from "react";
import { useGetStartedAnswers } from "../get-started/answers-context.js";
import { OnboardingTaskButton, RabbitAvatar } from "../onboarding-widget/parts.js";
import {
  requestOnboardingTask,
  requestOnboardingWidgetShow,
  useOnboardingWidgetStatus,
  type OnboardingWidgetStatus,
} from "../onboarding-widget/task-requests.js";
import { gettingStartedAppAction, gettingStartedAppActionLabel, gettingStartedAppToast, type GettingStartedAppAction } from "./actions.js";
import { useGettingStartedApp } from "./provider.js";
import { TaskArt } from "./task-art.js";

const TOTAL_TASKS = GETTING_STARTED_APP_TASK_IDS.length;

/** What the agent says on the hero, following the owner's progress. */
function agentLine(
  tasks: readonly GettingStartedAppTask[],
  doneCount: number,
  celebrating: readonly GettingStartedAppTaskId[],
  loaded: boolean,
  mirror: OnboardingWidgetStatus | null,
): string {
  if (!loaded) return "Getting your setup ready…";
  if (mirror && celebrating.length === 0) return mirrorAgentLine(mirror);
  const next = gettingStartedAppNextTask(tasks);
  const justDone = celebrating.at(-1);
  if (justDone) {
    const done = gettingStartedAppTask(justDone).doneMessage;
    if (next) return `${done}, nice. ${next.title} next?`;
    return gettingStartedAppAllChecked(tasks) ? `${done}, nice. That's the last one, Matrix is fully unlocked.` : `${done}, nice.`;
  }
  if (tasks.find((task) => task.id === "first-prompt")?.status !== "complete") {
    return "I'm Matrix. I work in your apps, even while you're away. Pick something and I'll start right away.";
  }
  if (next) return `${doneCount} of ${TOTAL_TASKS} done. ${next.title} next?`;
  return gettingStartedAppAllChecked(tasks) ? "Matrix is fully unlocked." : "Some of my checks didn't load. I'll try again shortly.";
}

/**
 * The widget status the hero mirrors: a task the widget is setting up or running, or an
 * open widget still waiting for the first pick. Otherwise (minimized, no widget, or done)
 * the hero shows its own content.
 */
function widgetToMirror(status: OnboardingWidgetStatus | null, firstPromptDone: boolean): OnboardingWidgetStatus | null {
  if (!status) return null;
  const kind = status.activity.kind;
  if (kind === "setup" || kind === "running" || kind === "failed") return status;
  return kind === "choosing" && status.open && !firstPromptDone ? status : null;
}

function mirrorAgentLine({ activity }: OnboardingWidgetStatus): string {
  switch (activity.kind) {
    case "choosing": return "I'm in the corner. Pick a task there and I'll start right away.";
    case "setup": return `Setting up ${activity.title} in the corner.`;
    case "running": return `Working on ${activity.title}. I'll let you know when it's ready.`;
    case "failed": return `${activity.title} hit a snag. Have a look in the corner.`;
    case "done": return `${activity.title} is ready.`;
  }
}

/**
 * Every task Matrix can check is Done (a failed status read is not), and no reward is still
 * landing. Cards Matrix cannot check yet never block the finish line.
 */
function isUnlocked(state: ReturnType<typeof useGettingStartedApp>): boolean {
  if (!state?.loaded || state.celebrating.length > 0 || state.awarding) return false;
  return gettingStartedAppAllChecked(state.tasks);
}

export function Hero({ onAction }: { onAction(action: GettingStartedAppAction): void }) {
  const state = useGettingStartedApp();
  const answers = useGetStartedAnswers();
  const tasks = state?.tasks ?? [];
  const loaded = state?.loaded ?? false;
  const firstPrompt = tasks.find((task) => task.id === "first-prompt");
  const startHere = !loaded || firstPrompt?.status !== "complete";
  const name = answers?.name?.trim();
  const widget = useOnboardingWidgetStatus();
  if (isUnlocked(state)) return <Unlocked name={name} onAction={onAction} />;
  const mirror = loaded ? widgetToMirror(widget, firstPrompt?.status === "complete") : null;

  return (
    <div className={`mxo-gsa__hero${startHere ? "" : " mxo-gsa__hero--compact"}`}>
      <div className="mxo-gsa__agent">
        <span className="mxo-gsa__glow mxo-gsa__glow--top" aria-hidden="true" />
        <span className="mxo-gsa__glow mxo-gsa__glow--bottom" aria-hidden="true" />
        <RabbitAvatar size={44} />
        <span className="mxo-gsa__agent-text">
          <span className="mxo-gsa__agent-greeting">{name ? `Hey ${name} 👋` : "Hey 👋"}</span>
          <span className="mxo-gsa__agent-line" aria-live="polite">
            {agentLine(tasks, state?.doneCount ?? 0, state?.celebrating ?? [], loaded, mirror)}
          </span>
        </span>
      </div>
      <div className="mxo-gsa__next">
        <HeroNext mirror={mirror} onAction={onAction} />
      </div>
    </div>
  );
}

/** The hero's right panel: loading, a reward, the widget mirror, Sahar's starter tasks, or the next task. */
function HeroNext({ mirror, onAction }: { mirror: OnboardingWidgetStatus | null; onAction(action: GettingStartedAppAction): void }) {
  const state = useGettingStartedApp();
  const tasks = state?.tasks ?? [];
  if (!state?.loaded) return <p className="mxo-gsa__next-description" role="status">Loading your tasks…</p>;
  const justDone = state.celebrating.at(-1);
  if (justDone) return <Reward key={justDone} taskId={justDone} />;
  const firstPrompt = tasks.find((task) => task.id === "first-prompt");
  if (mirror) return <WidgetMirror status={mirror} points={firstPrompt?.status === "complete" ? null : firstPrompt?.points ?? null} />;
  if (firstPrompt?.status !== "complete") return <StarterTasks points={firstPrompt?.points ?? 0} onAction={onAction} />;
  const next = gettingStartedAppNextTask(tasks);
  if (next) return <UpNext task={next} logo={state.logos[next.id]} earned={state.earned.includes(next.id)} onAction={onAction} />;
  // Nothing open, but not every check is Done: a status read failed, or a last award is landing.
  return (
    <>
      <h2 className="mxo-gsa__next-title">{state.awarding ? "Adding up your points" : "Some checks didn't load"}</h2>
      <p className="mxo-gsa__next-description" role="status">
        {state.awarding ? "One moment while Matrix records your last task." : "Matrix couldn't read some of your connections just now. It tries again shortly."}
      </p>
    </>
  );
}

const MIRROR_COPY: Record<OnboardingWidgetStatus["activity"]["kind"], { title(task: string): string; description: string }> = {
  choosing: { title: () => "Pick your first task in the corner", description: "Your starter tasks are in the Matrix panel. Pick one and I'll start right away." },
  setup: { title: (task) => `Setting up ${task}`, description: "Answer in the Matrix panel and I'll start." },
  running: { title: (task) => `Matrix is working on ${task}`, description: "It keeps going while you look around. The result shows up in the Matrix panel." },
  failed: { title: (task) => `${task} needs a look`, description: "Something went wrong. Open the Matrix panel to try again." },
  done: { title: (task) => `${task} is ready`, description: "See the result in the Matrix panel." },
};

/** Mirrors the corner widget so the app never lists its starter tasks a second time. */
function WidgetMirror({ status, points }: { status: OnboardingWidgetStatus; points: number | null }) {
  const { activity } = status;
  const copy = MIRROR_COPY[activity.kind];
  const title = copy.title("title" in activity ? activity.title : "");
  return (
    <>
      <div className="mxo-gsa__chips">
        <span className="mxo-gsa__badge mxo-gsa__badge--md mxo-gsa__badge--brand">In the Matrix panel</span>
        {points ? <span className="mxo-gsa__badge mxo-gsa__badge--md mxo-gsa__badge--gold">+{points} pts</span> : null}
      </div>
      <h2 className="mxo-gsa__next-title">{title}</h2>
      <div className={`mxo-gsa__mirror mxo-gsa__mirror--${activity.kind}`} aria-hidden="true">
        <RabbitAvatar size={32} />
        <span className="mxo-gsa__mirror-line">
          {activity.kind === "running" ? <LoaderCircle size={14} className="mxo-gsa__mirror-spin" /> : null}
          {activity.kind === "failed" ? <TriangleAlert size={14} /> : null}
          {activity.kind === "choosing" ? "What should I start on?" : "title" in activity ? activity.title : ""}
        </span>
      </div>
      <p className="mxo-gsa__next-description">{copy.description}</p>
      {status.open ? null : (
        <>
          <span className="mxo-gsa__spacer" aria-hidden="true" />
          <button type="button" className="mxo-gsa__primary mxo-gsa__primary--brand" onClick={() => requestOnboardingWidgetShow()}>
            Show Matrix panel
          </button>
        </>
      )}
    </>
  );
}

/** Confetti pieces for the unlocked banner: horizontal position (%), delay (ms) and brand color. */
const CONFETTI: ReadonlyArray<{ x: number; delay: number; color: string }> = [
  { x: 6, delay: 0, color: "var(--gsa-brand-gold)" },
  { x: 14, delay: 420, color: "var(--gsa-brand-teal)" },
  { x: 23, delay: 160, color: "var(--gsa-brand-glow)" },
  { x: 31, delay: 640, color: "var(--gsa-brand-gold)" },
  { x: 40, delay: 260, color: "#fafafa" },
  { x: 48, delay: 880, color: "var(--gsa-brand-teal)" },
  { x: 57, delay: 80, color: "var(--gsa-brand-gold)" },
  { x: 65, delay: 540, color: "var(--gsa-brand-glow)" },
  { x: 73, delay: 320, color: "#fafafa" },
  { x: 81, delay: 760, color: "var(--gsa-brand-gold)" },
  { x: 89, delay: 200, color: "var(--gsa-brand-teal)" },
  { x: 95, delay: 980, color: "var(--gsa-brand-glow)" },
];

/** Takes over the hero once nothing checkable is left: the finish line of onboarding, with some fanfare. */
function Unlocked({ name, onAction }: { name: string | undefined; onAction(action: GettingStartedAppAction): void }) {
  const state = useGettingStartedApp();
  const points = state?.points;
  const doneCount = state?.doneCount ?? 0;
  const waiting = (state?.tasks ?? []).some((task) => task.status !== "complete");
  return (
    <section className="mxo-gsa__unlocked" aria-label="Matrix unlocked">
      <span className="mxo-gsa__glow mxo-gsa__glow--top" aria-hidden="true" />
      <span className="mxo-gsa__glow mxo-gsa__glow--bottom" aria-hidden="true" />
      <span className="mxo-gsa__confetti" aria-hidden="true">
        {CONFETTI.map((piece) => (
          <i key={piece.x} style={{ left: `${piece.x}%`, animationDelay: `${piece.delay}ms`, background: piece.color }} />
        ))}
      </span>
      <span className="mxo-gsa__medal" aria-hidden="true">
        <span className="mxo-gsa__medal-rays" />
        <span className="mxo-gsa__medal-ring">
          <RabbitAvatar size={64} />
        </span>
        <span className="mxo-gsa__medal-star"><Star size={18} /></span>
      </span>
      <div className="mxo-gsa__unlocked-text">
        <span className="mxo-gsa__badge mxo-gsa__badge--md mxo-gsa__badge--gold">
          <Sparkles size={12} aria-hidden="true" />
          Onboarding complete
        </span>
        <h2 className="mxo-gsa__unlocked-title">Matrix is fully unlocked</h2>
        <p className="mxo-gsa__unlocked-line">
          {name ? `Nice work, ${name}. ` : "Nice work. "}
          Your agent is set up and your apps are connected, so Matrix can work for you at full potential. Hand it something big.
        </p>
        <div className="mxo-gsa__unlocked-stats">
          {points?.kind === "ready" ? <span className="mxo-gsa__unlocked-stat"><Star size={14} aria-hidden="true" />{points.total} pts collected</span> : null}
          <span className="mxo-gsa__unlocked-stat"><Check size={14} aria-hidden="true" />{doneCount} tasks done</span>
        </div>
        <button type="button" className="mxo-gsa__primary mxo-gsa__primary--gold" onClick={() => onAction({ type: "chat" })}>
          Put Matrix to work
        </button>
        {waiting ? <p className="mxo-gsa__unlocked-note">The other cards turn Done once Matrix can check them.</p> : null}
      </div>
    </section>
  );
}

/** Plays in the hero for a moment when a task pays out while the app is showing, then gives way to Up next. */
function Reward({ taskId }: { taskId: GettingStartedAppTaskId }) {
  const reward = gettingStartedAppToast(taskId, gettingStartedAppTask(taskId).points);
  return (
    <div className="mxo-gsa__reward" role="status" aria-label={`${reward.title}, ${reward.points} points`}>
      <span className="mxo-gsa__reward-burst" aria-hidden="true">
        <Star size={22} />
      </span>
      <h2 className="mxo-gsa__next-title">{reward.title}</h2>
      <span className="mxo-gsa__badge mxo-gsa__badge--md mxo-gsa__badge--gold">+{reward.points} pts</span>
    </div>
  );
}

function UpNext({ task, logo, earned, onAction }: {
  task: GettingStartedAppTask;
  logo: string | undefined;
  earned: boolean;
  onAction(action: GettingStartedAppAction): void;
}) {
  const action = gettingStartedAppAction(task.id);
  return (
    <>
      {/* The next task's own logo, large, gives the panel its color once the starter list is done. */}
      <span className="mxo-gsa__next-art" aria-hidden="true"><TaskArt task={task} logo={logo} /></span>
      <div className="mxo-gsa__chips">
        <span className="mxo-gsa__badge mxo-gsa__badge--md mxo-gsa__badge--brand">Up next</span>
        {earned ? (
          <span className="mxo-gsa__badge mxo-gsa__badge--md">{task.points} pts earned</span>
        ) : (
          <span className="mxo-gsa__badge mxo-gsa__badge--md mxo-gsa__badge--gold">+{task.points} pts</span>
        )}
      </div>
      <h2 className="mxo-gsa__next-title">{task.title}</h2>
      <p className="mxo-gsa__next-description">{task.description}</p>
      <span className="mxo-gsa__spacer" aria-hidden="true" />
      {action ? (
        <button type="button" className="mxo-gsa__primary mxo-gsa__primary--brand" onClick={() => onAction(action)}>
          {gettingStartedAppActionLabel(task.id)}
        </button>
      ) : null}
    </>
  );
}

/** Sahar's starter tasks, the same ones and the same component as the onboarding widget. */
function StarterTasks({ points, onAction }: { points: number; onAction(action: GettingStartedAppAction): void }) {
  const state = useGettingStartedApp();
  const answers = useGetStartedAnswers();
  const connected = useMemo(() => new Set(state?.connectedServices ?? []), [state?.connectedServices]);
  const starters = useMemo(() => orderByIds(ONBOARDING_TASKS, getStartedTaskOrder(answers?.goals ?? [], {
    ...(answers?.tools ? { tools: answers.tools } : {}),
    ...(answers?.starter ? { starter: answers.starter } : {}),
  })), [answers?.goals, answers?.starter, answers?.tools]);

  const start = (taskId: OnboardingStarterTaskId, label: string) => {
    // The corner widget runs it; without a widget, Chat starts it instead.
    if (!requestOnboardingTask(taskId)) onAction({ type: "chat", prompt: label });
  };

  return (
    <>
      <div className="mxo-gsa__chips">
        <span className="mxo-gsa__badge mxo-gsa__badge--md mxo-gsa__badge--brand">Start here</span>
        <span className="mxo-gsa__badge mxo-gsa__badge--md mxo-gsa__badge--gold">+{points} pts</span>
      </div>
      <h2 className="mxo-gsa__next-title">What should I start on?</h2>
      <ul className="mxo-card mxo-tasks mxo-gsa__starters" aria-label="Starter tasks">
        {starters.map((task) => (
          <li key={task.id}>
            <OnboardingTaskButton
              task={task}
              needsTag={task.needs && !connected.has(task.needs.service) ? task.needs.tag : null}
              onSelect={() => start(task.id, task.label)}
            />
          </li>
        ))}
      </ul>
      <p className="mxo-gsa__next-description">Pick one and I'll start right away. About 2 minutes.</p>
    </>
  );
}

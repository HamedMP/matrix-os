/**
 * The Getting started app window (spec 639). Iteration 2 makes it a
 * continuation of onboarding: the hero is the Matrix agent with Sahar's
 * starter tasks (shared with the onboarding widget), cards show the real
 * integration logos and sculpted app icons, and progress gets a little life.
 * Shared by Web Desktop, Web Canvas and Electron Desktop.
 */
import {
  GETTING_STARTED_APP_TASK_IDS,
  ONBOARDING_TASKS,
  getStartedTaskOrder,
  gettingStartedAppNextTask,
  gettingStartedAppTask,
  orderByIds,
  type GettingStartedAppTask,
  type GettingStartedAppTaskGroup,
  type GettingStartedAppTaskId,
  type OnboardingStarterTaskId,
} from "@matrix-os/contracts";
import { Check, Gift, LifeBuoy, Smartphone, Star, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { codingAgentArtworkSrc, settingsHarnessArtworkSrc } from "../coding-agent-artwork.js";
import { useGetStartedAnswers } from "../get-started/answers-context.js";
import { OnboardingTaskButton, RabbitAvatar } from "../onboarding-widget/parts.js";
import { requestOnboardingTask } from "../onboarding-widget/task-requests.js";
import {
  gettingStartedAppAction,
  gettingStartedAppActionLabel,
  type GettingStartedAppAction,
} from "./actions.js";
import { GETTING_STARTED_APP_BRAND_VARS } from "./brand-vars.js";
import { useGettingStartedApp, type GettingStartedAppPoints } from "./provider.js";

const SECTIONS: ReadonlyArray<{ group: Exclude<GettingStartedAppTaskGroup, "hero">; title: string }> = [
  { group: "build", title: "Build" },
  { group: "connect", title: "Connect" },
  { group: "further", title: "Go further" },
];

const TOTAL_TASKS = GETTING_STARTED_APP_TASK_IDS.length;

/** Sculpted app icons (v2 family) for the Build tasks. */
const SCULPTED_ICONS: Partial<Record<GettingStartedAppTaskId, string>> = {
  "build-app": "/system-app-icons/v2/create-app.png",
  "build-memory": "/system-app-icons/v2/notes.png",
};

const LINE_ICONS: Partial<Record<GettingStartedAppTaskId, LucideIcon>> = {
  "mobile-app": Smartphone,
  "invite-friends": Gift,
};

export function GettingStartedAppView({ onAction }: { onAction(action: GettingStartedAppAction): void }) {
  const state = useGettingStartedApp();
  if (!state?.enabled) return null;
  const { tasks, doneCount, points, loaded, logos } = state;
  const celebrating = new Set(state.celebrating);
  const progress = Math.round((doneCount / TOTAL_TASKS) * 100);

  return (
    <div className="mxo-gsa" style={GETTING_STARTED_APP_BRAND_VARS} aria-busy={!loaded}>
      <div className="mxo-gsa__inner">
        <header className="mxo-gsa__header">
          <h1 className="mxo-gsa__title">Getting started</h1>
          <div className="mxo-gsa__progress">
            <span className="mxo-gsa__count">{doneCount} of {TOTAL_TASKS} done</span>
            <span className="mxo-gsa__bar" role="progressbar" aria-label="Getting started progress" aria-valuemin={0} aria-valuemax={TOTAL_TASKS} aria-valuenow={doneCount}>
              <span className="mxo-gsa__bar-fill" style={{ width: `${progress}%` }} />
            </span>
            <PointsBadge points={points} />
          </div>
        </header>

        <Hero onAction={onAction} />

        {SECTIONS.map((section) => (
          <section key={section.group} className="mxo-gsa__section" aria-labelledby={`mxo-gsa-${section.group}`}>
            <h2 id={`mxo-gsa-${section.group}`} className="mxo-gsa__section-title">{section.title}</h2>
            <div className={`mxo-gsa__grid mxo-gsa__grid--${section.group}`}>
              {tasks.filter((task) => task.group === section.group).map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  logo={logos[task.id]}
                  celebrating={celebrating.has(task.id)}
                  onAction={onAction}
                />
              ))}
            </div>
          </section>
        ))}

        <button type="button" className="mxo-gsa__support" onClick={() => onAction({ type: "support" })}>
          <LifeBuoy size={16} aria-hidden="true" />
          Stuck? Chat with us
        </button>
      </div>
    </div>
  );
}

/** Counts up to a new total (skipped under reduced motion), so earning points feels like something. */
function useCountUp(target: number): number {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);
  useEffect(() => {
    const from = shownRef.current;
    if (from === target) return;
    const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced || typeof requestAnimationFrame === "undefined") {
      shownRef.current = target;
      setShown(target);
      return;
    }
    const startedAt = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - startedAt) / 600);
      const value = Math.round(from + (target - from) * (1 - (1 - t) ** 3));
      shownRef.current = value;
      setShown(value);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return shown;
}

function PointsBadge({ points }: { points: GettingStartedAppPoints }) {
  const total = points.kind === "ready" ? points.total : 0;
  const shown = useCountUp(total);
  const label = points.kind === "ready" ? `${points.total} points` : points.kind === "unavailable" ? "Points unavailable" : "Loading points";
  return (
    <span className="mxo-gsa__badge mxo-gsa__badge--md mxo-gsa__badge--gold" aria-label={label}>
      <Star size={12} aria-hidden="true" />
      {points.kind === "ready" ? `${shown} pts` : "– pts"}
    </span>
  );
}

/** What the agent says on the hero, following the owner's progress. */
function agentLine(tasks: readonly GettingStartedAppTask[], doneCount: number, celebrating: readonly GettingStartedAppTaskId[], loaded: boolean): string {
  if (!loaded) return "Getting your setup ready…";
  const next = gettingStartedAppNextTask(tasks);
  const justDone = celebrating.at(-1);
  if (justDone) {
    const done = gettingStartedAppTask(justDone).doneMessage;
    return next ? `${done}, nice. ${next.title} next?` : `${done}, nice. That's everything I can check for now.`;
  }
  if (doneCount === TOTAL_TASKS) return "You're all set. I'm here whenever you need me.";
  if (tasks.find((task) => task.id === "first-prompt")?.status !== "complete") {
    return "I'm Matrix. I work in your apps, even while you're away. Pick something and I'll start right away.";
  }
  return next ? `${doneCount} of ${TOTAL_TASKS} done. ${next.title} next?` : "The rest can't be checked yet, but you can still try them below.";
}

function Hero({ onAction }: { onAction(action: GettingStartedAppAction): void }) {
  const state = useGettingStartedApp();
  const answers = useGetStartedAnswers();
  const tasks = state?.tasks ?? [];
  const loaded = state?.loaded ?? false;
  const firstPrompt = tasks.find((task) => task.id === "first-prompt");
  const startHere = !loaded || firstPrompt?.status !== "complete";
  const name = answers?.name?.trim();

  return (
    <div className={`mxo-gsa__hero${startHere ? "" : " mxo-gsa__hero--compact"}`}>
      <div className="mxo-gsa__agent">
        <span className="mxo-gsa__glow mxo-gsa__glow--top" aria-hidden="true" />
        <span className="mxo-gsa__glow mxo-gsa__glow--bottom" aria-hidden="true" />
        <RabbitAvatar size={44} />
        <span className="mxo-gsa__agent-text">
          <span className="mxo-gsa__agent-greeting">{name ? `Hey ${name} 👋` : "Hey 👋"}</span>
          <span className="mxo-gsa__agent-line" aria-live="polite">
            {agentLine(tasks, state?.doneCount ?? 0, state?.celebrating ?? [], loaded)}
          </span>
        </span>
      </div>
      <div className="mxo-gsa__next">
        <HeroNext onAction={onAction} />
      </div>
    </div>
  );
}

/** The hero's right panel: loading, Sahar's starter tasks, the next task, or where things stand. */
function HeroNext({ onAction }: { onAction(action: GettingStartedAppAction): void }) {
  const state = useGettingStartedApp();
  const tasks = state?.tasks ?? [];
  if (!state?.loaded) return <p className="mxo-gsa__next-description" role="status">Loading your tasks…</p>;
  const firstPrompt = tasks.find((task) => task.id === "first-prompt");
  if (firstPrompt?.status !== "complete") return <StarterTasks points={firstPrompt?.points ?? 0} onAction={onAction} />;
  const next = gettingStartedAppNextTask(tasks);
  if (next) return <UpNext task={next} onAction={onAction} />;
  return state.doneCount === TOTAL_TASKS ? (
    <>
      <h2 className="mxo-gsa__next-title">You're all set</h2>
      <p className="mxo-gsa__next-description">Everything here is done. New ideas will show up as Matrix grows.</p>
    </>
  ) : (
    <>
      <h2 className="mxo-gsa__next-title">The rest can't be checked yet</h2>
      <p className="mxo-gsa__next-description">You can still try the remaining cards below. They'll show Done once Matrix can check them.</p>
    </>
  );
}

function UpNext({ task, onAction }: { task: GettingStartedAppTask; onAction(action: GettingStartedAppAction): void }) {
  const action = gettingStartedAppAction(task.id);
  return (
    <>
      <div className="mxo-gsa__chips">
        <span className="mxo-gsa__badge mxo-gsa__badge--md mxo-gsa__badge--brand">Up next</span>
        <span className="mxo-gsa__badge mxo-gsa__badge--md mxo-gsa__badge--gold">+{task.points} pts</span>
      </div>
      <h2 className="mxo-gsa__next-title">{task.title}</h2>
      <p className="mxo-gsa__next-description">{task.description}</p>
      <span className="mxo-gsa__spacer" aria-hidden="true" />
      {action ? (
        <button type="button" className="mxo-gsa__primary" onClick={() => onAction(action)}>
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

function TaskArt({ task, logo }: { task: GettingStartedAppTask; logo: string | undefined }) {
  // Remember which URL failed, so a new logo URL gets its own chance to load.
  const [failedLogo, setFailedLogo] = useState<string | null>(null);
  if (task.id === "create-agent") return <RabbitAvatar size={28} />;
  if (task.id === "ai-provider") {
    return (
      <span className="mxo-gsa__art-pair">
        <img src={settingsHarnessArtworkSrc("claude")} alt="" width={18} height={18} />
        <img src={settingsHarnessArtworkSrc("codex")} alt="" width={18} height={18} />
      </span>
    );
  }
  const sculpted = SCULPTED_ICONS[task.id];
  if (sculpted) return <img className="mxo-gsa__art-sculpted" src={codingAgentArtworkSrc(sculpted)} alt="" width={30} height={30} />;
  if (logo && logo !== failedLogo) {
    return <img className="mxo-gsa__art-logo" src={logo} alt="" width={22} height={22} referrerPolicy="no-referrer" onError={() => setFailedLogo(logo)} />;
  }
  const Icon = LINE_ICONS[task.id];
  return Icon ? <Icon size={20} strokeWidth={1.75} aria-hidden="true" /> : <span aria-hidden="true">{task.title.slice(0, 1)}</span>;
}

function TaskCard({ task, logo, celebrating, onAction }: {
  task: GettingStartedAppTask;
  logo: string | undefined;
  celebrating: boolean;
  onAction(action: GettingStartedAppAction): void;
}) {
  const action = gettingStartedAppAction(task.id);
  const done = task.status === "complete";
  return (
    <button
      type="button"
      className={`mxo-gsa__card${done ? " mxo-gsa__card--done" : ""}${celebrating ? " mxo-gsa__card--celebrate" : ""}`}
      disabled={!action}
      onClick={action ? () => onAction(action) : undefined}
    >
      <span className="mxo-gsa__card-top">
        <span className="mxo-gsa__card-icon" aria-hidden="true"><TaskArt task={task} logo={logo} /></span>
        <TaskChip task={task} available={action !== null} />
      </span>
      <span className="mxo-gsa__card-title">{task.title}</span>
      <span className="mxo-gsa__card-description">{task.description}</span>
    </button>
  );
}

/** Points until done; tasks Matrix cannot check yet keep their points and never show Done. */
function TaskChip({ task, available }: { task: GettingStartedAppTask; available: boolean }) {
  if (!available) return <span className="mxo-gsa__badge mxo-gsa__badge--sm">Coming soon</span>;
  if (task.status === "complete") {
    return (
      <span className="mxo-gsa__badge mxo-gsa__badge--sm mxo-gsa__badge--success">
        <Check size={12} aria-hidden="true" />
        <span>Done</span>
      </span>
    );
  }
  return <span className="mxo-gsa__badge mxo-gsa__badge--sm mxo-gsa__badge--gold">+{task.points} pts</span>;
}

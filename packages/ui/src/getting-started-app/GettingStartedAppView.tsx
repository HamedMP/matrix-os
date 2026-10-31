/**
 * The Getting started app window (spec 639): header, the hero (see hero.tsx)
 * and the task grid with real integration logos and sculpted app icons.
 * Shared by Web Desktop, Web Canvas and Electron Desktop.
 */
import {
  GETTING_STARTED_APP_TASK_IDS,
  gettingStartedAppTask,
  type GettingStartedAppTask,
  type GettingStartedAppTaskGroup,
  type GettingStartedAppTaskId,
} from "@matrix-os/contracts";
import { Check, LifeBuoy, Star } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { gettingStartedAppAction, gettingStartedAppSignIn, type GettingStartedAppAction } from "./actions.js";
import { GETTING_STARTED_APP_BRAND_VARS } from "./brand-vars.js";
import { Hero, TaskArt } from "./hero.js";
import { useGettingStartedApp, type GettingStartedAppPoints } from "./provider.js";

const SECTIONS: ReadonlyArray<{ group: Exclude<GettingStartedAppTaskGroup, "hero">; title: string }> = [
  { group: "build", title: "Build" },
  { group: "connect", title: "Connect" },
  { group: "further", title: "Go further" },
];

const TOTAL_TASKS = GETTING_STARTED_APP_TASK_IDS.length;

/**
 * `visible` is false while the window is minimized or its tab is in the background; awards
 * then go to the shell's corner toast instead of playing here.
 */
export function GettingStartedAppView({ onAction, visible = true }: { onAction(action: GettingStartedAppAction): void; visible?: boolean }) {
  const state = useGettingStartedApp();
  const registerView = state?.registerView;
  const showing = visible && state?.enabled === true;
  useEffect(() => (showing && registerView ? registerView() : undefined), [showing, registerView]);
  if (!state?.enabled) return null;
  const { tasks, doneCount, points, loaded, logos } = state;
  const celebrating = new Set(state.celebrating);
  const earned = new Set(state.earned);
  const progress = Math.round((doneCount / TOTAL_TASKS) * 100);

  return (
    // `ph-no-capture`: the hero shows the owner's name and mirrors their prompts, as the widget does.
    <div className="mxo-gsa ph-no-capture" style={GETTING_STARTED_APP_BRAND_VARS} aria-busy={!loaded}>
      <div className="mxo-gsa__inner">
        <header className="mxo-gsa__header">
          <h1 className="mxo-gsa__title">Getting started</h1>
          <div className="mxo-gsa__progress">
            <span className="mxo-gsa__count">{doneCount} of {TOTAL_TASKS} done</span>
            <span className="mxo-gsa__bar" role="progressbar" aria-label="Getting started progress" aria-valuemin={0} aria-valuemax={TOTAL_TASKS} aria-valuenow={doneCount}>
              <span className="mxo-gsa__bar-fill" style={{ width: `${progress}%` }} />
            </span>
            <PointsBadge points={points} gainedFrom={state.celebrating.at(-1)} />
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
                  earned={earned.has(task.id)}
                  celebrating={celebrating.has(task.id)}
                  signIn={gettingStartedAppSignIn(task.id, state.connectingService, state.failedServices)}
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

/** The header total; a fresh award floats its "+N" up out of the badge while the total counts up. */
function PointsBadge({ points, gainedFrom }: { points: GettingStartedAppPoints; gainedFrom: GettingStartedAppTaskId | undefined }) {
  const total = points.kind === "ready" ? points.total : 0;
  const shown = useCountUp(total);
  const label = points.kind === "ready" ? `${points.total} points` : points.kind === "unavailable" ? "Points unavailable" : "Loading points";
  return (
    <span className="mxo-gsa__badge mxo-gsa__badge--md mxo-gsa__badge--gold mxo-gsa__points" aria-label={label}>
      <Star size={12} aria-hidden="true" />
      {points.kind === "ready" ? `${shown} pts` : "– pts"}
      {gainedFrom ? (
        <span key={gainedFrom} className="mxo-gsa__points-pop" aria-hidden="true">+{gettingStartedAppTask(gainedFrom).points}</span>
      ) : null}
    </span>
  );
}


function TaskCard({ task, logo, earned, celebrating, signIn, onAction }: {
  task: GettingStartedAppTask;
  logo: string | undefined;
  earned: boolean;
  celebrating: boolean;
  signIn: "connecting" | "failed" | null;
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
        <TaskChip task={task} earned={earned} available={action !== null} signIn={signIn} />
      </span>
      <span className="mxo-gsa__card-title">{task.title}</span>
      <span className="mxo-gsa__card-description">{task.description}</span>
    </button>
  );
}

/**
 * Points until done; tasks Matrix cannot check yet keep their points and never show Done.
 * An earned task that is undone (e.g. Slack disconnected) keeps its points but offers no more.
 */
function TaskChip({ task, earned, available, signIn }: {
  task: GettingStartedAppTask;
  earned: boolean;
  available: boolean;
  signIn: "connecting" | "failed" | null;
}) {
  if (!available) return <span className="mxo-gsa__badge mxo-gsa__badge--sm">Coming soon</span>;
  if (task.status !== "complete" && signIn === "connecting") return <span className="mxo-gsa__badge mxo-gsa__badge--sm mxo-gsa__badge--brand">Connecting…</span>;
  if (task.status !== "complete" && signIn === "failed") return <span className="mxo-gsa__badge mxo-gsa__badge--sm mxo-gsa__badge--gold">Didn't connect, try again</span>;
  if (task.status === "complete") {
    return (
      <span className="mxo-gsa__badge mxo-gsa__badge--sm mxo-gsa__badge--success">
        <Check size={12} aria-hidden="true" />
        <span>Done</span>
      </span>
    );
  }
  if (earned) return <span className="mxo-gsa__badge mxo-gsa__badge--sm">{task.points} pts earned</span>;
  return <span className="mxo-gsa__badge mxo-gsa__badge--sm mxo-gsa__badge--gold">+{task.points} pts</span>;
}

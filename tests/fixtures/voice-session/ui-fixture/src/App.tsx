import React, { useEffect, useMemo, useRef, useState } from "react";
import { VoicePanel } from "../../../../../packages/ui/src/voice-session/VoicePanel";
import {
  useVoiceSessionController,
  type VoiceSessionCommand,
  type VoiceSessionViewState,
} from "../../../../../packages/ui/src/voice-session/controller";
import type { VoiceSimulatorScenario } from "../../../../../packages/gateway/src/voice-session/simulator-adapter";
import {
  backpressureScenario,
  normalScenario,
  permissionDeniedScenario,
  reconnectScenario,
  terminalCleanupScenario,
  usingToolScenario,
} from "../../scenarios/index";
import { runFixtureSession } from "./session-runner";

type ScenarioId =
  | "connecting"
  | "listening"
  | "thinking"
  | "using-tool"
  | "speaking"
  | "paused"
  | "reconnecting"
  | "failed"
  | "permission-denied"
  | "reduced-motion"
  | "ended";

type Scenario = {
  id: ScenarioId;
  label: string;
  media: VoiceSimulatorScenario;
  displayUntilMs: number;
  turnMode?: VoiceSessionViewState["turnMode"];
  reducedMotion?: boolean;
};

const SCENARIOS: readonly Scenario[] = [
  { id: "connecting", label: "Connecting", media: normalScenario, displayUntilMs: -1 },
  { id: "listening", label: "Listening", media: normalScenario, displayUntilMs: 35 },
  { id: "thinking", label: "Thinking", media: normalScenario, displayUntilMs: 65 },
  { id: "using-tool", label: "Using tool", media: usingToolScenario, displayUntilMs: 65 },
  { id: "speaking", label: "Speaking", media: normalScenario, displayUntilMs: 95 },
  { id: "paused", label: "Paused", media: backpressureScenario, displayUntilMs: 25 },
  { id: "reconnecting", label: "Reconnecting", media: reconnectScenario, displayUntilMs: 15 },
  { id: "failed", label: "Failed", media: terminalCleanupScenario, displayUntilMs: Number.POSITIVE_INFINITY },
  { id: "permission-denied", label: "Permission denied", media: permissionDeniedScenario, displayUntilMs: Number.POSITIVE_INFINITY },
  {
    id: "reduced-motion",
    label: "Reduced motion",
    media: normalScenario,
    displayUntilMs: 35,
    turnMode: "push_to_talk",
    reducedMotion: true,
  },
  { id: "ended", label: "Ended", media: normalScenario, displayUntilMs: Number.POSITIVE_INFINITY },
] as const;

function scenarioFromUrl(): ScenarioId {
  const candidate = new URLSearchParams(window.location.search).get("scenario");
  return SCENARIOS.some(({ id }) => id === candidate) ? (candidate as ScenarioId) : "listening";
}

function VoiceFixture({ scenario }: { scenario: Scenario }) {
  // Replay-time commands arrive while useMemo runs the deterministic pipeline;
  // interactive commands only reach React state through the post-mount sink.
  const commandSink = useRef<(command: VoiceSessionCommand) => void>(() => undefined);
  const [lastCommand, setLastCommand] = useState<string | null>(null);
  const run = useMemo(
    () => runFixtureSession(scenario.media, {
      displayUntilMs: scenario.displayUntilMs,
      turnMode: scenario.turnMode,
      onCommand: (command: VoiceSessionCommand) => commandSink.current(command),
    }),
    [scenario],
  );
  const state = useVoiceSessionController(run.controller);

  useEffect(() => {
    commandSink.current = (command) => setLastCommand(command.type);
    setLastCommand(null);
    return () => {
      commandSink.current = () => undefined;
      run.controller.dispose();
    };
  }, [run]);

  const shownCommand = lastCommand ?? run.evidence.commands.at(-1) ?? "No control selected";

  return (
    <div
      className={scenario.reducedMotion ? "fixture-voice fixture-reduced-motion" : "fixture-voice"}
    >
      <VoicePanel state={state} controller={run.controller} />
      <dl className="fixture-evidence" aria-label="Deterministic qualification evidence">
        <div>
          <dt>Media scenario</dt>
          <dd>{run.evidence.mediaScenarioId}</dd>
        </div>
        <div>
          <dt>Media journal</dt>
          <dd>{run.evidence.mediaJournalEntries} entries</dd>
        </div>
        <div>
          <dt>Terminal state</dt>
          <dd>
            {run.evidence.mediaDisplayCutMs === null
              ? run.evidence.mediaTerminalState
              : `${run.evidence.mediaTerminalState} (display cut at ${run.evidence.mediaDisplayCutMs} ms)`}
          </dd>
        </div>
        <div>
          <dt>Frames</dt>
          <dd>{run.evidence.framesAccepted} accepted, {run.evidence.framesRejected} fenced</dd>
        </div>
        <div>
          <dt>Canonical revision</dt>
          <dd>{run.evidence.canonicalRevision}</dd>
        </div>
        <div>
          <dt>Admissions</dt>
          <dd>
            {run.evidence.admissions.length === 0
              ? "none"
              : run.evidence.admissions
                .map((admission) => `${admission.requestId}: ${admission.outcome}`)
                .join(", ")}
          </dd>
        </div>
        <div>
          <dt>Active run</dt>
          <dd>{run.evidence.activeRunId ?? "none"}</dd>
        </div>
        <div>
          <dt>Deliveries</dt>
          <dd>
            {run.evidence.deliveries.length === 0
              ? "none"
              : run.evidence.deliveries
                .map((delivery) => `${delivery.responseId}=${delivery.state}`)
                .join(", ")}
          </dd>
        </div>
        <div>
          <dt>Cleanup</dt>
          <dd>{run.evidence.mediaResourcesClean ? "clean" : "incomplete"}</dd>
        </div>
      </dl>
      <p className="fixture-command" aria-live="polite">
        Fixture command: {shownCommand}
      </p>
    </div>
  );
}

export function App() {
  const [scenarioId, setScenarioId] = useState<ScenarioId>(scenarioFromUrl);
  const scenario = SCENARIOS.find(({ id }) => id === scenarioId) ?? SCENARIOS[1];

  const selectScenario = (next: ScenarioId) => {
    const url = new URL(window.location.href);
    url.searchParams.set("scenario", next);
    window.history.replaceState(null, "", url);
    setScenarioId(next);
  };

  return (
    <main className="fixture-shell">
      <header className="fixture-toolbar">
        <div>
          <p>Matrix UI fixture</p>
          <h1>Voice mode attached to Chat</h1>
        </div>
        <label>
          Scenario
          <select
            name="scenario"
            autoComplete="off"
            value={scenarioId}
            onChange={(event) => selectScenario(event.target.value as ScenarioId)}
          >
            {SCENARIOS.map(({ id, label }) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
        </label>
      </header>

      <section className="fixture-stage" aria-label="Canonical Chat with voice mode">
        <article className="fixture-chat" aria-label="Chat">
          <header>
            <div className="fixture-avatar" aria-hidden="true">M</div>
            <div>
              <h2>Launch planning</h2>
              <p>Canonical Chat</p>
            </div>
          </header>
          <div className="fixture-messages">
            <div className="fixture-message fixture-message--user">
              <p>Can you review the launch plan and call out anything blocking us?</p>
            </div>
            <div className="fixture-message fixture-message--assistant">
              <p>I found three areas to verify: release ownership, recovery evidence, and the accessibility review.</p>
              <ul>
                <li>Release owner is assigned</li>
                <li>Recovery exercise is scheduled</li>
                <li>Voice controls are ready for review</li>
              </ul>
            </div>
          </div>
          <div className="fixture-composer" aria-hidden="true">
            <span>Message Matrix…</span>
            <span>Send</span>
          </div>
        </article>

        <aside className="fixture-panel-slot" aria-label={`${scenario.label} voice scenario`}>
          <VoiceFixture key={scenario.id} scenario={scenario} />
        </aside>
      </section>
    </main>
  );
}

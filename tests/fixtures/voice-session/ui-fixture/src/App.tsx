import React, { useEffect, useMemo, useState } from "react";
import { VoicePanel } from "../../../../../packages/ui/src/voice-session/VoicePanel";
import {
  VoiceSessionController,
  useVoiceSessionController,
  type VoiceSessionCommand,
  type VoiceSessionViewState,
} from "../../../../../packages/ui/src/voice-session/controller";
import {
  DeterministicVoiceSimulator,
  type VoiceSimulatorScenario,
} from "../../../../../packages/gateway/src/voice-session/simulator-adapter";
import {
  interruptionScenario,
  normalScenario,
  permissionDeniedScenario,
  reconnectScenario,
  sessionQuotaScenario,
} from "../../scenarios/index";
import { FakeCanonicalChatHarness } from "../../canonical-chat-harness";

const FIXTURE_SESSION_ID = "vs_ui";

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
  state: VoiceSessionViewState["state"];
  turnMode?: VoiceSessionViewState["turnMode"];
  toolLabel?: string;
  transcript?: string;
  error?: { code: string; recovery: string; retryable: boolean };
  reducedMotion?: boolean;
};

const SCENARIOS: readonly Scenario[] = [
  { id: "connecting", label: "Connecting", state: "connecting" },
  {
    id: "listening",
    label: "Listening",
    state: "listening",
    transcript: "Show me the launch checklist for this project…",
  },
  { id: "thinking", label: "Thinking", state: "thinking" },
  {
    id: "using-tool",
    label: "Using tool",
    state: "using_tool",
    toolLabel: "Reviewing project files",
  },
  { id: "speaking", label: "Speaking", state: "speaking" },
  { id: "paused", label: "Paused", state: "paused" },
  { id: "reconnecting", label: "Reconnecting", state: "reconnecting" },
  {
    id: "failed",
    label: "Failed",
    state: "failed",
    error: { code: "connection_failed", recovery: "retry_connection", retryable: true },
  },
  {
    id: "permission-denied",
    label: "Permission denied",
    state: "failed",
    error: { code: "permission_denied", recovery: "request_permission", retryable: true },
  },
  {
    id: "reduced-motion",
    label: "Reduced motion",
    state: "listening",
    turnMode: "push_to_talk",
    reducedMotion: true,
  },
  { id: "ended", label: "Ended", state: "ended" },
] as const;

function scenarioFromUrl(): ScenarioId {
  const candidate = new URLSearchParams(window.location.search).get("scenario");
  return SCENARIOS.some(({ id }) => id === candidate) ? (candidate as ScenarioId) : "listening";
}

function mediaScenarioFor(scenario: Scenario): VoiceSimulatorScenario {
  switch (scenario.id) {
    case "permission-denied":
      return permissionDeniedScenario;
    case "reconnecting":
      return reconnectScenario;
    case "speaking":
      return interruptionScenario;
    case "failed":
      return sessionQuotaScenario;
    default:
      return normalScenario;
  }
}

interface QualificationEvidence {
  mediaScenarioId: string;
  mediaJournalEntries: number;
  mediaTerminalState: string;
  mediaResourcesClean: boolean;
  canonicalRevision: number;
  admissionOutcome: string;
}

export function buildQualificationEvidence(scenario: Scenario): QualificationEvidence {
  const mediaScenario = mediaScenarioFor(scenario);
  const media = new DeterministicVoiceSimulator().run(mediaScenario);
  const harness = new FakeCanonicalChatHarness();
  const admission = harness.admit({
    requestId: "req_voice_fixture",
    finalityId: "vfinal_voice_fixture",
    source: "voice",
    localOrder: 1,
    baseRevision: 0,
    routeId: "route_fixture",
    interactionMode: "default",
    permissionMode: "supervised",
    memoryMode: "session_only",
    choice: "send",
    transcript: "fixture-only transcript",
  });
  const { resources } = media;
  return {
    mediaScenarioId: mediaScenario.scenarioId,
    mediaJournalEntries: media.journal.length,
    mediaTerminalState: media.terminalState,
    mediaResourcesClean:
      !resources.capture
      && !resources.transport
      && resources.playbackSegments === 0
      && resources.timers === 0
      && resources.queuedAudioMs === 0,
    canonicalRevision: harness.snapshot().revision,
    admissionOutcome: admission.outcome,
  };
}

function createController(
  scenario: Scenario,
  onCommand: (command: VoiceSessionCommand) => void,
): VoiceSessionController {
  const controller = new VoiceSessionController({
    initialEpoch: 7,
    sessionId: FIXTURE_SESSION_ID,
    initialTurnMode: scenario.turnMode,
    onCommand,
  });
  let sequence = 1;
  controller.receive({
    contractVersion: 1,
    sessionId: FIXTURE_SESSION_ID,
    type: "session.state",
    epoch: 7,
    sequence: sequence++,
    state: scenario.state,
  });
  if (scenario.transcript) {
    controller.receive({
      contractVersion: 1,
      sessionId: FIXTURE_SESSION_ID,
      type: "transcript.provisional",
      epoch: 7,
      sequence: sequence++,
      turnId: "vturn_fixture",
      revision: 1,
      text: scenario.transcript,
    });
  }
  if (scenario.toolLabel) {
    controller.receive({
      contractVersion: 1,
      sessionId: FIXTURE_SESSION_ID,
      type: "operation.status",
      epoch: 7,
      sequence: sequence++,
      runId: "run_fixture",
      label: scenario.toolLabel,
      state: "running",
    });
  }
  if (scenario.state === "speaking") {
    controller.receive({
      contractVersion: 1,
      sessionId: FIXTURE_SESSION_ID,
      type: "response.started",
      epoch: 7,
      sequence: sequence++,
      runId: "run_fixture",
      responseId: "vresp_fixture",
    });
  }
  if (scenario.error) {
    controller.receive({
      contractVersion: 1,
      sessionId: FIXTURE_SESSION_ID,
      type: "session.error",
      epoch: 7,
      sequence: sequence++,
      ...scenario.error,
    });
  }
  return controller;
}

function VoiceFixture({ scenario }: { scenario: Scenario }) {
  const [lastCommand, setLastCommand] = useState("No control selected");
  const controller = useMemo(
    () => createController(scenario, (command) => setLastCommand(command.type)),
    [scenario],
  );
  const evidence = useMemo(() => buildQualificationEvidence(scenario), [scenario]);
  const state = useVoiceSessionController(controller);

  useEffect(() => () => controller.dispose(), [controller]);

  return (
    <div
      className={scenario.reducedMotion ? "fixture-voice fixture-reduced-motion" : "fixture-voice"}
    >
      <VoicePanel state={state} controller={controller} />
      <dl className="fixture-evidence" aria-label="Deterministic qualification evidence">
        <div>
          <dt>Media scenario</dt>
          <dd>{evidence.mediaScenarioId}</dd>
        </div>
        <div>
          <dt>Media journal</dt>
          <dd>{evidence.mediaJournalEntries} entries</dd>
        </div>
        <div>
          <dt>Terminal state</dt>
          <dd>{evidence.mediaTerminalState}</dd>
        </div>
        <div>
          <dt>Canonical revision</dt>
          <dd>{evidence.canonicalRevision}</dd>
        </div>
        <div>
          <dt>Admission</dt>
          <dd>{evidence.admissionOutcome}</dd>
        </div>
        <div>
          <dt>Cleanup</dt>
          <dd>{evidence.mediaResourcesClean ? "clean" : "incomplete"}</dd>
        </div>
      </dl>
      <p className="fixture-command" aria-live="polite">
        Fixture command: {lastCommand}
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

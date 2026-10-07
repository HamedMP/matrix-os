import { ChatPresentationPreview } from "./ChatPresentationPreview";
/**
 * Standalone Aoede fixture — the real `ShellAoedeHost` (singleton launcher,
 * command-palette registration, panel and canonical cards) rendered on a mock
 * OS surface with Chat never mounted. The only seams replaced are the
 * documented injection points: the gateway `fetcher` (in-process canonical
 * fake) and `controllerDeps.voiceFactory` (deterministic server-frame player).
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ShellAoedeHost } from "@/components/ShellAoedeHost";
import { useCommandStore } from "@/stores/commands";
import { AOEDE_PREFERENCES_STORAGE_KEY } from "../../../../../packages/ui/src/aoede/preferences";
import { AOEDE_SCENARIOS, scenarioById, type AoedeScenario } from "./scenarios";
import { createFixtureBackend, createFixtureEvidence, type FixtureEvidence } from "./fixture-backend";
import { createFixtureVoiceFactory } from "./fixture-media";
import { driveScenario, type DriverResult } from "./driver";

export type FixtureSurface = "web_canvas" | "web_desktop";

function surfaceFromUrl(): FixtureSurface {
  const candidate = new URLSearchParams(window.location.search).get("surface");
  return candidate === "web_desktop" ? "web_desktop" : "web_canvas";
}

function scenarioFromUrl(): string {
  const candidate = new URLSearchParams(window.location.search).get("scenario");
  return scenarioById(candidate).id;
}

/** Deterministic prefs: a previous run's persisted turn mode must not leak in. */
function clearFixturePrefs() {
  try {
    window.localStorage.removeItem(AOEDE_PREFERENCES_STORAGE_KEY);
  } catch {
    // storage may be unavailable — the fixture tolerates it
  }
}

function MockCanvasStage() {
  return (
    <div className="fixture-canvas" data-testid="fixture-surface-canvas">
      <div className="fixture-canvas__grid" aria-hidden="true" />
      <article className="fixture-window" style={{ left: "6%", top: "12%", width: 320 }}>
        <header>Timer</header>
        <p>09:41 remaining</p>
      </article>
      <article className="fixture-window" style={{ left: "44%", top: "38%", width: 280 }}>
        <header>Calendar</header>
        <p>Launch review · 15:00</p>
      </article>
      <p className="fixture-surface-note">Web Canvas stage — Chat is not mounted.</p>
    </div>
  );
}

function MockDesktopStage() {
  return (
    <div className="fixture-desktop" data-testid="fixture-surface-desktop">
      <div className="fixture-desktop__icons" aria-hidden="true">
        <span>Terminal</span>
        <span>Files</span>
        <span>Timer</span>
      </div>
      <article className="fixture-window" style={{ left: "18%", top: "18%", width: 340 }}>
        <header>Notes</header>
        <p>Desktop surface, no Chat window is open.</p>
      </article>
      <div className="fixture-taskbar" aria-hidden="true">
        <span className="fixture-taskbar__start">Matrix</span>
        <span>15:04</span>
      </div>
      <p className="fixture-surface-note">Web Desktop stage — Chat is not mounted.</p>
    </div>
  );
}

/**
 * Minimal command-palette surface backed by the real shell `useCommandStore`.
 * The host registers its Aoede command here; invoking it proves launcher and
 * palette converge on the same singleton controller (focus/reveal semantics).
 */
function FixtureCommandPalette() {
  const commands = useCommandStore((state) => state.commands);
  const entries = [...commands.values()];
  return (
    <nav className="fixture-palette" aria-label="Mock command palette">
      {entries.length === 0 ? <span className="fixture-palette__empty">no commands registered</span> : null}
      {entries.map((command) => (
        <button
          key={command.id}
          type="button"
          data-fixture-command={command.id}
          onClick={(event) => command.execute({ invoker: event.currentTarget })}
        >
          ⌘ {command.label}
        </button>
      ))}
    </nav>
  );
}

function EvidencePanel({ evidence, scenario, surface, result }: {
  evidence: FixtureEvidence;
  scenario: AoedeScenario;
  surface: FixtureSurface;
  result: DriverResult | null;
}) {
  const snapshot = useSyncExternalStore(evidence.subscribe, evidence.snapshot, evidence.snapshot);
  return (
    <aside className="fixture-evidence" data-schema-issues={snapshot.schemaIssues.length}
      data-speech-seam="fake" data-canonical-provider-seam="fake" aria-label="Deterministic fixture evidence">
      <dl>
        <div><dt>Surface</dt><dd>{surface === "web_canvas" ? "web_canvas (Canvas)" : "web_desktop (Desktop)"}</dd></div>
        <div><dt>Scenario</dt><dd>{scenario.id}</dd></div>
        <div><dt>Composition</dt><dd>real ShellAoedeHost + real controller/panel/cards</dd></div>
        <div><dt>Boundary</dt><dd>in-process fakes — fetcher + voiceFactory only, no network, no providers</dd></div>
        <div>
          <dt>Canonical calls</dt>
          <dd>
            {snapshot.calls.length === 0
              ? "none yet"
              : snapshot.calls.map(call => `#${call.index} ${call.method} ${call.path} → ${call.status}${call.note ? ` (${call.note})` : ""}`).join(" · ")}
          </dd>
        </div>
        <div>
          <dt>Media</dt>
          <dd>{snapshot.media.length === 0 ? "no media started" : snapshot.media.join(" · ")}</dd>
        </div>
        <div>
          <dt>Navigation</dt>
          <dd>{snapshot.navigation.length === 0 ? "none" : snapshot.navigation.join(" · ")}</dd>
        </div>
        <div>
          <dt>Schema issues</dt>
          <dd>{snapshot.schemaIssues.length === 0 ? "none" : snapshot.schemaIssues.join(" · ")}</dd>
        </div>
        <div><dt>Driver</dt><dd>{result ? (result.ok ? "settled" : `errors: ${result.errors.join("; ")}`) : "running"}</dd></div>
      </dl>
      <p className="fixture-summary">{scenario.summary}</p>
    </aside>
  );
}

function ScenarioFixture({ scenario, surface }: { scenario: AoedeScenario; surface: FixtureSurface }) {
  const [result, setResult] = useState<DriverResult | null>(null);
  const rig = useMemo(() => {
    clearFixturePrefs();
    const evidence = createFixtureEvidence();
    const backend = createFixtureBackend({ detail: scenario.detail(), bootstrap: scenario.bootstrap, evidence });
    const voiceFactory = createFixtureVoiceFactory(scenario.media ?? { frames: [] }, evidence);
    return { evidence, fetcher: backend.fetcher, voiceFactory };
  }, [scenario]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void driveScenario(scenario).then((outcome) => {
        if (!cancelled) setResult(outcome);
      });
    }, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [scenario, rig]);

  return (
    <>
      <ShellAoedeHost
        userId="user_aoede_fixture"
        runtimeSlot="fixture"
        surface={surface}
        supported
        fetcher={rig.fetcher}
        controllerDeps={{ voiceFactory: rig.voiceFactory }}
        onOpenHistory={(chatId) => rig.evidence.recordNavigation(`history:${chatId}`)}
        onOpenResult={(path) => rig.evidence.recordNavigation(`result:${path}`)}
        onOpenNavigation={(nav) => rig.evidence.recordNavigation(`navigation:${nav.app}:${nav.path}`)}
      >
        <section className="fixture-stage" aria-label={`${surface} surface with Aoede`}>
          {new URLSearchParams(window.location.search).get("chat-preview") === "1" ? <ChatPresentationPreview /> : surface === "web_canvas" ? <MockCanvasStage /> : <MockDesktopStage />}
        </section>
      </ShellAoedeHost>
      <EvidencePanel evidence={rig.evidence} scenario={scenario} surface={surface} result={result} />
      <div
        id="aoede-fixture-ready"
        data-aoede-ready={result === null ? "pending" : result.ok ? "true" : "error"}
        data-aoede-state={result?.state ?? ""}
        data-aoede-scenario={scenario.id}
        hidden
      />
    </>
  );
}

export function App() {
  const [scenarioId, setScenarioId] = useState<string>(scenarioFromUrl);
  const [surface, setSurface] = useState<FixtureSurface>(surfaceFromUrl);
  const scenario = scenarioById(scenarioId);

  const patchUrl = (key: "scenario" | "surface", value: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set(key, value);
    window.history.replaceState(null, "", url);
  };

  return (
    <main className="fixture-shell">
      <header className="fixture-toolbar">
        <div>
          <p>Matrix OS fixture</p>
          <h1>Aoede — standalone assistant (Chat closed)</h1>
          <p className="fixture-subtitle">
            Shell-owned singleton host on a mock surface. The canonical fake answers every Aoede
            request in-process; the voice client replays contract frames. No Chat, no network.
          </p>
        </div>
        <div className="fixture-controls">
          <label>
            Surface
            <select
              name="surface"
              autoComplete="off"
              value={surface}
              onChange={(event) => {
                patchUrl("surface", event.target.value);
                setSurface(event.target.value as FixtureSurface);
              }}
            >
              <option value="web_canvas">web_canvas</option>
              <option value="web_desktop">web_desktop</option>
            </select>
          </label>
          <label>
            Scenario
            <select
              name="scenario"
              autoComplete="off"
              value={scenario.id}
              onChange={(event) => {
                patchUrl("scenario", event.target.value);
                setScenarioId(event.target.value);
              }}
            >
              {AOEDE_SCENARIOS.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          <FixtureCommandPalette />
        </div>
      </header>

      {/* Stable scenario index for the screenshot runner — never rendered Chat. */}
      <nav className="fixture-index" aria-label="Scenario index" hidden>
        {AOEDE_SCENARIOS.map(({ id }) => (
          <a key={id} data-scenario-id={id} href={`?scenario=${id}`}>{id}</a>
        ))}
      </nav>

      <ScenarioFixture key={scenario.id} scenario={scenario} surface={surface} />
    </main>
  );
}

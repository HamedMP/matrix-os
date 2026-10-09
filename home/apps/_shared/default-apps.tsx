import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./theme.css";

type AppId = "games" | "pomodoro" | "profile" | "social";

function getLauncher(): ((name: string, path: string) => void) | undefined {
  const bridge: unknown = Reflect.get(window, "MatrixOS");
  if (!bridge || typeof bridge !== "object") return undefined;
  const openApp: unknown = Reflect.get(bridge, "openApp");
  if (typeof openApp !== "function") return undefined;
  return (name, path) => { Reflect.apply(openApp, bridge, [name, path]); };
}

const games = [
  { id: "2048", title: "2048", kind: "Numbers", description: "One move. A little more room.", art: "2 4 8 16" },
  { id: "chess", title: "Chess", kind: "Strategy", description: "Take your time. Find your move.", art: "♞" },
  { id: "solitaire", title: "Solitaire", kind: "Cards", description: "A quiet table, a fresh deal.", art: "A ♠" },
  { id: "snake", title: "Snake", kind: "Arcade", description: "Keep moving. Leave a way out.", art: "● ● ● ●" },
  { id: "minesweeper", title: "Minesweeper", kind: "Puzzle", description: "Every number tells you something.", art: "1 2 ✳" },
  { id: "tetris", title: "Tetris", kind: "Arcade", description: "Make space for what comes next.", art: "▟ ▀ ▙" },
  { id: "backgammon", title: "Backgammon", kind: "Board", description: "A little chance. A lot of strategy.", art: "◉ ◉ ⚄" },
] as const;

function GameCenter() {
  const [error, setError] = useState<string | null>(null);
  const launchApp = getLauncher();
  const canLaunch = Boolean(launchApp);
  return (
    <main className="game-library">
      <header className="library-head"><h1>A little play.</h1><p>Seven games. A moment to yourself.</p></header>
      {!canLaunch && <p className="availability-note">Open Game Center inside Matrix to play these games.</p>}
      {error && <p role="alert">{error}</p>}
      <div className="game-shelf">
        {games.map((game) => (
          <article className={`game-cover game-cover--${game.id}`} key={game.id}>
            <div className="game-art" aria-hidden="true">{game.art}</div>
            <div className="game-caption"><span>{game.kind}</span><h2>{game.title}</h2><p>{game.description}</p></div>
            <button className="play-button" disabled={!canLaunch} type="button" aria-label={`Play ${game.title}`} onClick={() => {
              setError(null);
              try { launchApp?.(game.title, `apps/games/${game.id}/index.html`); }
              catch (cause) { console.warn("Game launch failed", cause); setError("This game could not be opened. Try again."); }
            }}>Play</button>
          </article>
        ))}
      </div>
    </main>
  );
}

function Pomodoro() {
  const [duration, setDuration] = useState(25 * 60);
  const [remaining, setRemaining] = useState(duration);
  const [running, setRunning] = useState(false);
  const [intent, setIntent] = useState("");
  const deadline = useRef<number | null>(null);
  useEffect(() => {
    if (!running) return;
    const tick = () => {
      const next = Math.max(0, Math.ceil(((deadline.current ?? Date.now()) - Date.now()) / 1000));
      setRemaining(next);
      if (next === 0) setRunning(false);
    };
    const interval = window.setInterval(tick, 250);
    const refresh = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(interval); document.removeEventListener("visibilitychange", refresh); };
  }, [running]);
  const formatted = `${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`;
  return (
    <main className="focus-room">
      <header><h1>One thing at a time.</h1><p>Give it a little room.</p></header>
      <label className="intent-label">What are you focusing on?<input aria-label="Focus intention" value={intent} maxLength={240} onChange={(event) => setIntent(event.target.value)} placeholder="Name the one thing…" /></label>
      <div className="focus-clock">
        <span role="timer" aria-label="Focus time remaining" aria-live="off">{formatted}</span>
      </div>
      <div className="focus-presets" role="group" aria-label="Session duration">{[25, 5, 15].map((minutes) => <button key={minutes} type="button" aria-pressed={duration === minutes * 60} onClick={() => { setDuration(minutes * 60); setRemaining(minutes * 60); setRunning(false); deadline.current = null; }}>{minutes === 25 ? "Focus" : minutes === 5 ? "Short break" : "Long break"}</button>)}</div>
      <div className="focus-actions"><button type="button" className="focus-start" disabled={remaining === 0} onClick={() => {
        if (running) { setRemaining(Math.max(0, Math.ceil(((deadline.current ?? Date.now()) - Date.now()) / 1000))); setRunning(false); }
        else { deadline.current = Date.now() + remaining * 1000; setRunning(true); }
      }}>{running ? "Pause focus" : "Start focus"}</button><button type="button" className="focus-reset" onClick={() => { setRunning(false); setRemaining(duration); deadline.current = null; }}>Reset timer</button></div>
      <p className="focus-status" role="status">{remaining === 0 ? "Session complete. Take a breath." : running ? "Your time is yours." : "Ready when you are."}</p>
      <p className="availability-note">This session resets when you close the app. Background alerts are not enabled.</p>
    </main>
  );
}

function UnconnectedApp({ id }: { id: "profile" | "social" }) {
  return <main className={`unconnected-app unconnected-app--${id}`}>
    <div className="identity-art" aria-hidden="true">{id === "profile" ? "◎" : "◌"}</div>
    <h1>{id === "profile" ? "A place for you." : "A place to connect."}</h1>
    <p>{id === "profile" ? "No profile data connected to this app." : "No feed connected to this app."}</p>
    <p className="availability-note">{id === "profile" ? "Manage your identity in Matrix Settings. This app needs a profile connection before it can show your details." : "Use the connected Social view in Matrix. This app needs a feed connection before it can show posts or publish updates."}</p>
  </main>;
}

export function DefaultApp({ id }: { id: AppId }) {
  return <div className={`default-app default-app--${id}`}>{id === "games" ? <GameCenter /> : id === "pomodoro" ? <Pomodoro /> : <UnconnectedApp id={id} />}</div>;
}

export function renderDefaultApp(id: AppId) {
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing #root");
  createRoot(root).render(<React.StrictMode><DefaultApp id={id} /></React.StrictMode>);
}

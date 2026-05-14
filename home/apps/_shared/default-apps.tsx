import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./theme.css";

type AppId =
  | "2048"
  | "backgammon"
  | "calculator"
  | "chess"
  | "clock"
  | "expense-tracker"
  | "games"
  | "minesweeper"
  | "pomodoro"
  | "profile"
  | "snake"
  | "social"
  | "solitaire"
  | "tetris"
  | "todo"
  | "weather";

type Metric = {
  label: string;
  value: string;
  tone?: string;
};

const appMeta: Record<AppId, { title: string; subtitle: string; accent: string; metrics?: Metric[] }> = {
  "2048": {
    title: "2048",
    subtitle: "Merge matching tiles and keep the board open.",
    accent: "#D06F25",
    metrics: [
      { label: "Score", value: "2,048" },
      { label: "Best", value: "8,192" },
    ],
  },
  backgammon: {
    title: "Backgammon",
    subtitle: "A clean board for fast tactical play.",
    accent: "#434E3F",
    metrics: [
      { label: "Match", value: "7 pt" },
      { label: "Pip lead", value: "+18" },
    ],
  },
  calculator: {
    title: "Calculator",
    subtitle: "Scientific keypad with a compact history rail.",
    accent: "#434E3F",
  },
  chess: {
    title: "Chess",
    subtitle: "Classic board, clear coordinates, fast analysis.",
    accent: "#32352E",
    metrics: [
      { label: "Turn", value: "White" },
      { label: "Eval", value: "+0.4" },
    ],
  },
  clock: {
    title: "Clock",
    subtitle: "World clock, timer, and focus-friendly timekeeping.",
    accent: "#434E3F",
    metrics: [
      { label: "Local", value: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) },
      { label: "Focus", value: "25:00" },
    ],
  },
  "expense-tracker": {
    title: "Expense Tracker",
    subtitle: "Track spend by category with budget pressure visible.",
    accent: "#434E3F",
    metrics: [
      { label: "May spend", value: "$1,284" },
      { label: "Budget left", value: "$716" },
    ],
  },
  games: {
    title: "Game Center",
    subtitle: "A focused arcade shelf for built-in Matrix games.",
    accent: "#D06F25",
    metrics: [
      { label: "Games", value: "7" },
      { label: "Streak", value: "12" },
    ],
  },
  minesweeper: {
    title: "Minesweeper",
    subtitle: "A crisp puzzle grid with instant scanning.",
    accent: "#D06F25",
    metrics: [
      { label: "Mines", value: "10" },
      { label: "Time", value: "00:37" },
    ],
  },
  pomodoro: {
    title: "Pomodoro",
    subtitle: "Focus cycles with simple session intent.",
    accent: "#D06F25",
    metrics: [
      { label: "Today", value: "5" },
      { label: "Cycle", value: "Focus" },
    ],
  },
  profile: {
    title: "Profile",
    subtitle: "Your public Matrix identity and presence.",
    accent: "#434E3F",
    metrics: [
      { label: "Posts", value: "24" },
      { label: "Following", value: "128" },
    ],
  },
  snake: {
    title: "Snake",
    subtitle: "Arrow-key arcade with a compact board.",
    accent: "#434E3F",
    metrics: [
      { label: "Length", value: "18" },
      { label: "Speed", value: "7" },
    ],
  },
  social: {
    title: "Social",
    subtitle: "Feed, follows, and posts inside your own workspace.",
    accent: "#D06F25",
    metrics: [
      { label: "Unread", value: "9" },
      { label: "Reach", value: "2.4K" },
    ],
  },
  solitaire: {
    title: "Solitaire",
    subtitle: "A calm Klondike table for quick breaks.",
    accent: "#32352E",
    metrics: [
      { label: "Moves", value: "38" },
      { label: "Stock", value: "17" },
    ],
  },
  tetris: {
    title: "Tetris",
    subtitle: "Clean stack, visible queue, no visual noise.",
    accent: "#434E3F",
    metrics: [
      { label: "Lines", value: "42" },
      { label: "Level", value: "6" },
    ],
  },
  todo: {
    title: "Todo",
    subtitle: "A minimal task board with priority and dates.",
    accent: "#434E3F",
    metrics: [
      { label: "Open", value: "7" },
      { label: "Due today", value: "3" },
    ],
  },
  weather: {
    title: "Weather",
    subtitle: "Current conditions and a readable daily forecast.",
    accent: "#434E3F",
    metrics: [
      { label: "Now", value: "72°F" },
      { label: "Wind", value: "8 mph" },
    ],
  },
};

const gameCards: AppId[] = ["2048", "minesweeper", "snake", "tetris", "chess", "solitaire", "backgammon"];

function Header({ id }: { id: AppId }) {
  const meta = appMeta[id];
  return (
    <header className="app-header">
      <div className="app-mark" style={{ background: meta.accent }}>
        {meta.title.slice(0, 2).toUpperCase()}
      </div>
      <div>
        <h1>{meta.title}</h1>
        <p>{meta.subtitle}</p>
      </div>
      <div className="header-actions">
        <button className="btn btn-ghost" type="button">Share</button>
        <button className="btn btn-primary" style={{ "--accent": meta.accent } as React.CSSProperties} type="button">
          New
        </button>
      </div>
    </header>
  );
}

function Metrics({ id }: { id: AppId }) {
  const metrics = appMeta[id].metrics ?? [];
  if (metrics.length === 0) return null;
  return (
    <section className="metrics">
      {metrics.map((metric) => (
        <div className="metric" key={metric.label}>
          <span>{metric.label}</span>
          <strong>{metric.value}</strong>
        </div>
      ))}
    </section>
  );
}

function CalculatorApp() {
  const [display, setDisplay] = useState("128 × 3");
  const [history, setHistory] = useState(["42 ÷ 7 = 6", "18 × 12 = 216", "sqrt(144) = 12"]);
  const keys = ["7", "8", "9", "÷", "4", "5", "6", "×", "1", "2", "3", "-", "0", ".", "=", "+"];
  return (
    <main className="app-grid calculator-layout">
      <section className="card calculator-panel">
        <div className="calculator-display">{display}</div>
        <div className="keypad">
          {keys.map((key) => (
            <button
              className={key.match(/[÷×+=-]/) ? "key key-accent" : "key"}
              key={key}
              type="button"
              onClick={() => {
                if (key === "=") {
                  setHistory((items) => [`${display} = 384`, ...items].slice(0, 4));
                  setDisplay("384");
                } else {
                  setDisplay((value) => (value === "384" ? key : `${value} ${key}`));
                }
              }}
            >
              {key}
            </button>
          ))}
        </div>
      </section>
      <section className="card side-list">
        <h2>History</h2>
        {history.map((item) => <p key={item}>{item}</p>)}
      </section>
    </main>
  );
}

function ClockApp() {
  const now = useMemo(() => new Date(), []);
  return (
    <main className="app-grid two-up">
      <section className="card time-card">
        <span className="eyebrow">Local time</span>
        <strong>{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</strong>
        <p>{now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</p>
      </section>
      <section className="card timer-card">
        <span className="eyebrow">Focus timer</span>
        <strong>25:00</strong>
        <div className="segmented">
          <button type="button">Focus</button>
          <button type="button">Break</button>
          <button type="button">Long</button>
        </div>
      </section>
    </main>
  );
}

function ExpensesApp() {
  const rows = [
    ["Workspace", "$420", "Tools"],
    ["Travel", "$260", "Ops"],
    ["Research", "$180", "AI"],
    ["Design", "$95", "Brand"],
  ];
  return (
    <main className="app-grid ledger-layout">
      <section className="card chart-card">
        <span className="eyebrow">Budget pressure</span>
        <div className="bar-stack">
          <span style={{ width: "48%", background: "#434E3F" }} />
          <span style={{ width: "28%", background: "#D06F25" }} />
          <span style={{ width: "18%", background: "#D6AB8B" }} />
        </div>
        <p>Most spend is concentrated in tools and workspace operations.</p>
      </section>
      <section className="card table-card">
        <h2>Recent</h2>
        {rows.map(([name, amount, category]) => (
          <div className="table-row" key={name}>
            <span>{name}</span>
            <small>{category}</small>
            <strong>{amount}</strong>
          </div>
        ))}
      </section>
    </main>
  );
}

function GameCenterApp() {
  return (
    <main className="game-grid">
      {gameCards.map((id) => (
        <article className="card game-card" key={id} style={{ "--accent": appMeta[id].accent } as React.CSSProperties}>
          <div className="game-card-art">{appMeta[id].title.slice(0, 2).toUpperCase()}</div>
          <h2>{appMeta[id].title}</h2>
          <p>{appMeta[id].subtitle}</p>
          <button className="btn btn-ghost" type="button">Open</button>
        </article>
      ))}
    </main>
  );
}

function BoardGame({ id }: { id: AppId }) {
  const size = id === "chess" ? 8 : id === "minesweeper" ? 9 : 6;
  return (
    <main className="app-grid board-layout">
      <section className={`card board board-${id}`}>
        {Array.from({ length: size * size }, (_, index) => (
          <span key={index}>{id === "minesweeper" && index % 7 === 0 ? "3" : ""}</span>
        ))}
      </section>
      <section className="card side-list">
        <h2>Session</h2>
        <p>Ready state synced to your Matrix home.</p>
        <p>Keyboard shortcuts stay local to this app window.</p>
        <button className="btn btn-primary" style={{ "--accent": appMeta[id].accent } as React.CSSProperties} type="button">
          Start game
        </button>
      </section>
    </main>
  );
}

function ArcadeApp({ id }: { id: "snake" | "tetris" | "2048" }) {
  const cells = id === "2048" ? ["2", "4", "8", "", "", "16", "", "", "32", "", "", "", "", "", "", ""] : [];
  return (
    <main className="app-grid board-layout">
      <section className={`card arcade arcade-${id}`}>
        {id === "2048"
          ? cells.map((cell, index) => <span key={index}>{cell}</span>)
          : Array.from({ length: 120 }, (_, index) => <span className={index % 11 === 0 ? "active" : ""} key={index} />)}
      </section>
      <section className="card side-list">
        <h2>Controls</h2>
        <p>Arrow keys move. Space pauses. State is local until you save.</p>
        <button className="btn btn-primary" style={{ "--accent": appMeta[id].accent } as React.CSSProperties} type="button">
          Play
        </button>
      </section>
    </main>
  );
}

function PomodoroApp() {
  return (
    <main className="app-grid two-up">
      <section className="card time-card">
        <span className="eyebrow">Current session</span>
        <strong>24:12</strong>
        <p>Design review focus block</p>
      </section>
      <section className="card side-list">
        <h2>Today</h2>
        <p>5 focus sessions completed</p>
        <p>2 short breaks remaining</p>
        <button className="btn btn-primary" type="button">Start</button>
      </section>
    </main>
  );
}

function ProfileApp() {
  return (
    <main className="app-grid profile-layout">
      <section className="card profile-card">
        <div className="avatar">M</div>
        <h2>Matrix User</h2>
        <p>@you:matrix-os.com</p>
        <button className="btn btn-primary" type="button">Edit profile</button>
      </section>
      <section className="card side-list">
        <h2>Presence</h2>
        <p>Building in Matrix OS</p>
        <p>Public apps: 8</p>
        <p>Shared canvases: 3</p>
      </section>
    </main>
  );
}

function SocialApp() {
  const posts = ["Shipped a fresh workspace canvas.", "Reviewing the latest user image.", "Designing default app icons."];
  return (
    <main className="app-grid social-layout">
      <section className="card composer">
        <textarea placeholder="Post an update" />
        <button className="btn btn-primary" type="button">Publish</button>
      </section>
      <section className="feed">
        {posts.map((post) => (
          <article className="card post" key={post}>
            <strong>Matrix</strong>
            <p>{post}</p>
          </article>
        ))}
      </section>
    </main>
  );
}

function TodoApp() {
  const tasks = ["Demo hamedmp VPS", "Refresh default icons", "Build app bundle", "Verify canvas pan"];
  return (
    <main className="app-grid todo-layout">
      <section className="card task-list">
        {tasks.map((task, index) => (
          <label className="check-row" key={task}>
            <input defaultChecked={index < 2} type="checkbox" />
            <span>{task}</span>
            <small>{index === 0 ? "Today" : "Soon"}</small>
          </label>
        ))}
      </section>
      <section className="card side-list">
        <h2>Priority</h2>
        <p>Keep demo path clean: apps open built, icons resolve, terminal loads.</p>
      </section>
    </main>
  );
}

function WeatherApp() {
  return (
    <main className="app-grid weather-layout">
      <section className="card weather-main">
        <span className="eyebrow">San Francisco</span>
        <strong>72°</strong>
        <p>Clear, light wind, excellent visibility.</p>
      </section>
      <section className="card forecast">
        {["Tue", "Wed", "Thu", "Fri"].map((day, index) => (
          <div className="forecast-row" key={day}>
            <span>{day}</span>
            <strong>{72 - index}°</strong>
            <small>{index % 2 ? "Clouds" : "Clear"}</small>
          </div>
        ))}
      </section>
    </main>
  );
}

function Content({ id }: { id: AppId }) {
  if (id === "calculator") return <CalculatorApp />;
  if (id === "clock") return <ClockApp />;
  if (id === "expense-tracker") return <ExpensesApp />;
  if (id === "games") return <GameCenterApp />;
  if (id === "pomodoro") return <PomodoroApp />;
  if (id === "profile") return <ProfileApp />;
  if (id === "social") return <SocialApp />;
  if (id === "todo") return <TodoApp />;
  if (id === "weather") return <WeatherApp />;
  if (id === "snake" || id === "tetris" || id === "2048") return <ArcadeApp id={id} />;
  return <BoardGame id={id} />;
}

function DefaultApp({ id }: { id: AppId }) {
  return (
    <div className="matrix-app" style={{ "--accent": appMeta[id].accent } as React.CSSProperties}>
      <div className="matrix-shell">
        <Header id={id} />
        <Metrics id={id} />
        <Content id={id} />
      </div>
    </div>
  );
}

export function renderDefaultApp(id: AppId) {
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing #root");
  createRoot(root).render(
    <React.StrictMode>
      <DefaultApp id={id} />
    </React.StrictMode>,
  );
}

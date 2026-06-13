export default function App() {
  return (
    <div className="flex h-full flex-col">
      <header
        className="titlebar-drag flex items-center justify-center border-b"
        style={{ height: "var(--titlebar-height)", borderColor: "var(--border-subtle)" }}
      >
        <span className="text-sm" style={{ color: "var(--text-tertiary)" }}>
          Matrix OS
        </span>
      </header>
      <main className="flex flex-1 items-center justify-center">
        <p style={{ color: "var(--text-secondary)" }}>Operator scaffold — Phase 1</p>
      </main>
    </div>
  );
}

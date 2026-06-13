import { useEffect, useState } from "react";
import { Button } from "../../design/primitives";
import { invoke } from "../../lib/operator";
import { useConnection } from "../../stores/connection";

interface SystemInfoSummary {
  version?: string;
  uptime?: number;
  runtime?: { handle?: string; runtimeSlot?: string };
  resources?: { cpuCount?: number; memoryTotal?: number; memoryFree?: number; diskTotal?: number; diskFree?: number };
  release?: { version?: string; channel?: string };
}

function formatBytes(bytes: number | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "–";
  const gb = bytes / 1024 ** 3;
  return `${gb.toFixed(1)} GB`;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      className="flex flex-col gap-3 rounded-xl border p-4"
      style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)" }}
    >
      <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
        {title}
      </h3>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span style={{ color: "var(--text-secondary)" }}>{label}</span>
      <span style={{ color: "var(--text-primary)" }} data-selectable>
        {value}
      </span>
    </div>
  );
}

export default function SettingsView() {
  const handle = useConnection((s) => s.handle);
  const platformHost = useConnection((s) => s.platformHost);
  const runtimeSlot = useConnection((s) => s.runtimeSlot);
  const selectRuntime = useConnection((s) => s.selectRuntime);
  const api = useConnection((s) => s.api);
  const [slotInput, setSlotInput] = useState(runtimeSlot);
  const [theme, setTheme] = useState<"dark" | "light" | "system">("dark");
  const [info, setInfo] = useState<SystemInfoSummary | null>(null);
  const [infoError, setInfoError] = useState(false);

  useEffect(() => {
    void invoke("state:get", { key: "appearance" }).then((result) => {
      const value = result.value as { theme?: string } | null;
      if (value?.theme === "light" || value?.theme === "system" || value?.theme === "dark") {
        setTheme(value.theme);
      }
    });
  }, []);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api
      .get<SystemInfoSummary>("/api/system/info")
      .then((data) => {
        if (!cancelled) setInfo(data);
      })
      .catch(() => {
        if (!cancelled) setInfoError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const applyTheme = (next: "dark" | "light" | "system") => {
    setTheme(next);
    const resolved =
      next === "system"
        ? window.matchMedia("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark"
        : next;
    document.documentElement.setAttribute("data-theme", resolved);
    void invoke("state:set", { key: "appearance", value: { theme: next } }).catch((err: unknown) => {
      console.warn(
        "[settings] persist appearance failed:",
        err instanceof Error ? err.message : String(err),
      );
    });
  };

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
      <h2 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
        Settings
      </h2>

      <Section title="Account">
        <Row label="Handle" value={handle ? `@${handle}` : "–"} />
        <Row label="Platform" value={platformHost} />
      </Section>

      <Section title="Runtime">
        <Row label="Active runtime" value={runtimeSlot} />
        <div className="flex items-center gap-2">
          <input
            value={slotInput}
            onChange={(e) => setSlotInput(e.target.value)}
            maxLength={64}
            className="h-7 flex-1 rounded-md border bg-transparent px-2 text-sm outline-none"
            style={{ borderColor: "var(--border-default)", color: "var(--text-primary)" }}
            placeholder="primary"
          />
          <Button
            variant="primary"
            disabled={slotInput.trim().length === 0 || slotInput === runtimeSlot}
            onClick={() => void selectRuntime(slotInput.trim())}
          >
            Switch
          </Button>
        </div>
      </Section>

      <Section title="Appearance">
        <div className="flex gap-2">
          {(["dark", "light", "system"] as const).map((option) => (
            <Button
              key={option}
              variant={theme === option ? "primary" : "subtle"}
              onClick={() => applyTheme(option)}
            >
              {option[0]?.toUpperCase()}
              {option.slice(1)}
            </Button>
          ))}
        </div>
      </Section>

      <Section title="System">
        {infoError ? (
          <p className="text-sm" style={{ color: "var(--text-tertiary)" }}>
            System info unavailable.
          </p>
        ) : (
          <>
            <Row label="OS version" value={info?.version ?? "–"} />
            <Row label="Release channel" value={info?.release?.channel ?? "–"} />
            <Row
              label="Memory free"
              value={`${formatBytes(info?.resources?.memoryFree)} of ${formatBytes(info?.resources?.memoryTotal)}`}
            />
            <Row
              label="Disk free"
              value={`${formatBytes(info?.resources?.diskFree)} of ${formatBytes(info?.resources?.diskTotal)}`}
            />
          </>
        )}
      </Section>
    </div>
  );
}

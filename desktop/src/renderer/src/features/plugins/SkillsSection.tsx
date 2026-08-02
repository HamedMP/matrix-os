// Skills section of the Plugins hub. REAL data path: GET /api/settings/skills
// (see plugins-store.ts) — the list below is the actual installed skill pack
// on the connected computer, rendered read-only. The empty state is honest:
// no skills installed, with the canonical terminal path to manage them.
import { Search, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { categoryMessage } from "../../../../shared/app-error";
import { Button } from "../../design/primitives";
import { useConnection } from "../../stores/connection";
import { useTabs } from "../../stores/tabs";
import { openPluginsTerminal } from "./open-plugins-terminal";
import { usePlugins } from "./plugins-store";

const SKILLS_TERMINAL_SESSION = "plugins-skills";

function SkillsLoadingSkeleton() {
  return (
    <div data-testid="plugins-skills-loading" className="flex flex-col gap-3" aria-label="Loading skills">
      {[0, 1, 2].map((row) => (
        <div key={row} className="h-14 animate-pulse rounded-xl" style={{ background: "var(--bg-surface)" }} />
      ))}
    </div>
  );
}

export function SkillsSection() {
  const api = useConnection((s) => s.api);
  const openTab = useTabs((s) => s.openTab);
  const skills = usePlugins((s) => s.skills);
  const status = usePlugins((s) => s.skillsStatus);
  const errorMessage = usePlugins((s) => s.skillsError);
  const [terminalBusy, setTerminalBusy] = useState(false);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredSkills = useMemo(() => {
    if (!normalizedQuery) return skills;
    return skills.filter((skill) =>
      [skill.name, skill.description, skill.file]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery)),
    );
  }, [normalizedQuery, skills]);

  useEffect(() => {
    void usePlugins.getState().refreshSkills(api);
  }, [api]);

  const refresh = (): void => {
    void usePlugins.getState().refreshSkills(api);
  };

  const handleOpenTerminal = async (): Promise<void> => {
    if (terminalBusy) return;
    if (!api) {
      setTerminalError(categoryMessage("misconfigured"));
      return;
    }
    setTerminalBusy(true);
    setTerminalError(null);
    try {
      const opened = await openPluginsTerminal(api, openTab, {
        sessionName: SKILLS_TERMINAL_SESSION,
        title: "Skills",
      });
      // "runtime-changed" is not a failure: the session was created on the
      // computer the user just left, so there is nothing to apologise for.
      if (opened === "failed") setTerminalError(categoryMessage("server"));
    } finally {
      setTerminalBusy(false);
    }
  };

  let body: ReactNode;
  if (status === "idle" || status === "loading") {
    body = <SkillsLoadingSkeleton />;
  } else if (status === "unavailable") {
    body = (
      <div
        data-testid="plugins-skills-unavailable"
        className="flex flex-col items-center gap-2 rounded-xl border p-8 text-center"
        style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)" }}
      >
        <Sparkles size={20} style={{ color: "var(--text-tertiary)" }} />
        <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
          Skills are unavailable on this runtime.
        </p>
        <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
          This computer's gateway does not expose the skills API.
        </p>
      </div>
    );
  } else if (status === "error") {
    body = (
      <div
        className="flex flex-col items-center gap-3 rounded-xl border p-8 text-center"
        style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)" }}
      >
        <p className="text-sm" style={{ color: "var(--text-primary)" }}>
          {errorMessage ?? categoryMessage("server")}
        </p>
        <Button onClick={refresh}>Retry</Button>
      </div>
    );
  } else if (skills.length === 0) {
    body = (
      <div
        className="flex flex-col items-center gap-2 rounded-xl border p-8 text-center"
        style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)" }}
      >
        <Sparkles size={20} style={{ color: "var(--text-tertiary)" }} />
        <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
          No skills installed yet.
        </p>
        <p className="max-w-[360px] text-xs" style={{ color: "var(--text-tertiary)" }}>
          Skills are markdown instruction packs under .agents/skills on your Matrix computer.
          Ask Hermes to create one, or manage them in a terminal.
        </p>
        <div className="mt-2">
          <Button variant="primary" disabled={terminalBusy} onClick={() => void handleOpenTerminal()}>
            {terminalBusy ? "Opening…" : "Open terminal"}
          </Button>
        </div>
        {terminalError ? (
          <p className="text-xs" style={{ color: "var(--danger)" }}>{terminalError}</p>
        ) : null}
      </div>
    );
  } else if (filteredSkills.length === 0) {
    body = (
      <div
        className="flex flex-col items-center gap-2 rounded-xl border p-10 text-center"
        style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)" }}
      >
        <Search size={20} style={{ color: "var(--text-tertiary)" }} />
        <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
          No skills match “{query.trim()}”
        </p>
        <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
          Search by skill name, description, or file path.
        </p>
        <Button variant="ghost" onClick={() => setQuery("")}>Clear search</Button>
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-2">
        {filteredSkills.map((skill) => (
          <div
            key={skill.name}
            className="group flex items-start gap-3 rounded-xl border px-4 py-3.5 transition-colors duration-150 hover:bg-[var(--bg-hover)]"
            style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)" }}
          >
            <span
              className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
              style={{ color: "var(--accent)", background: "var(--accent-muted)" }}
            >
              <Sparkles size={15} />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                {skill.name}
              </span>
              {skill.description ? (
                <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                  {skill.description}
                </span>
              ) : null}
              {skill.file ? (
                <span className="font-mono text-xs" style={{ color: "var(--text-tertiary)" }}>
                  {skill.file}
                </span>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    );
  }

  const skillCountLabel = normalizedQuery
    ? `${filteredSkills.length} of ${skills.length} skills`
    : `${skills.length} ${skills.length === 1 ? "skill" : "skills"} installed`;

  return (
    <>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h3 className="text-xl font-semibold tracking-tight" style={{ color: "var(--text-primary)" }}>
            Skills
          </h3>
          <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
            Reusable instruction packs installed on your Matrix computer.
          </p>
        </div>
        {status === "ready" ? (
          <Button variant="ghost" onClick={refresh}>
            Refresh
          </Button>
        ) : null}
      </div>

      {status === "ready" && skills.length > 0 ? (
        <div className="mb-4 flex items-center gap-3">
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">Search skills</span>
            <Search
              aria-hidden="true"
              size={15}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
              style={{ color: "var(--text-tertiary)" }}
            />
            <input
              type="search"
              aria-label="Search skills"
              placeholder="Search skills"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-9 w-full rounded-lg border bg-transparent pl-9 pr-9 text-sm outline-none transition-colors placeholder:text-[var(--text-tertiary)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-muted)]"
              style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}
            />
            {query ? (
              <button
                type="button"
                aria-label="Clear skill search"
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md hover:bg-[var(--bg-hover)]"
                style={{ color: "var(--text-tertiary)" }}
              >
                <X size={13} />
              </button>
            ) : null}
          </label>
          <span className="shrink-0 text-xs tabular-nums" style={{ color: "var(--text-tertiary)" }}>
            {skillCountLabel}
          </span>
        </div>
      ) : null}

      {body}
    </>
  );
}

export default SkillsSection;

// Skills section of the Plugins hub. REAL data path: GET /api/settings/skills
// (see plugins-store.ts) — the list below is the actual installed skill pack
// on the connected computer, rendered read-only. The empty state is honest:
// no skills installed, with the canonical terminal path to manage them.
import { Sparkles } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
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
    const opened = await openPluginsTerminal(api, openTab, {
      sessionName: SKILLS_TERMINAL_SESSION,
      title: "Skills",
    });
    setTerminalBusy(false);
    if (!opened) setTerminalError(categoryMessage("server"));
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
  } else {
    body = (
      <div className="flex flex-col gap-2">
        {skills.map((skill) => (
          <div
            key={skill.name}
            className="flex items-start gap-3 rounded-xl border px-4 py-3"
            style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)" }}
          >
            <span className="mt-0.5" style={{ color: "var(--accent)" }}>
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

      {body}
    </>
  );
}

export default SkillsSection;

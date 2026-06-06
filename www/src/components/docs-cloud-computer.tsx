import {
  Bot,
  Cloud,
  Database,
  GitBranch,
  MonitorUp,
  PanelsTopLeft,
  Terminal,
  Users,
} from 'lucide-react';

const reasons = [
  {
    title: 'Always-on compute',
    body: 'Keep terminals, dev servers, previews, review loops, and agents alive after the laptop closes.',
    icon: MonitorUp,
  },
  {
    title: 'Agents keep running',
    body: 'Claude, Codex, Pi, OpenCode, and Hermes work inside the same cloud machine instead of fighting local sleep.',
    icon: Bot,
  },
  {
    title: 'Work from anywhere',
    body: 'Move between the web shell, CLI, and upcoming Mac/iOS apps without moving the project.',
    icon: Terminal,
  },
  {
    title: 'Shared with teammates',
    body: 'Hand off a running workspace, terminal session, repo, or preview without recreating local setup.',
    icon: Users,
  },
  {
    title: 'Context in one place',
    body: 'Files, repos, settings, skills, logs, integrations, and agent history live in the Matrix workspace.',
    icon: Database,
  },
];

export function DocsCloudComputer() {
  return (
    <section className="not-prose docs-cloud-computer" aria-labelledby="matrix-cloud-title">
      <div className="docs-cloud-visual" aria-hidden="true">
        <svg className="docs-cloud-lines" viewBox="0 0 720 420" fill="none">
          <path
            className="docs-cloud-flow docs-cloud-flow-one"
            d="M128 210 C210 102 341 88 460 148 C525 181 568 178 633 112"
          />
          <path
            className="docs-cloud-flow docs-cloud-flow-two"
            d="M120 246 C220 300 360 318 498 256 C552 232 596 246 650 300"
          />
          <path
            className="docs-cloud-flow docs-cloud-flow-three"
            d="M192 176 C284 206 348 229 424 214 C493 200 536 205 606 220"
          />
        </svg>

        <div className="docs-cloud-window">
          <div className="docs-cloud-window-bar">
            <span />
            <span />
            <span />
            <p>matrix-shell</p>
          </div>
          <div className="docs-cloud-terminal">
            <p>
              <span>$</span> matrix shell connect
            </p>
            <p>
              <span>$</span> gh auth login
            </p>
            <p>
              <span>$</span> codex run review-loop
            </p>
            <p className="docs-cloud-terminal-live">agent session still running</p>
          </div>
        </div>

        <div className="docs-cloud-core">
          <Cloud />
          <p>Matrix computer</p>
          <span>online</span>
        </div>

        <div className="docs-cloud-node docs-cloud-node-agent">
          <Bot />
          <span>agents</span>
        </div>
        <div className="docs-cloud-node docs-cloud-node-repo">
          <GitBranch />
          <span>repo</span>
        </div>
        <div className="docs-cloud-node docs-cloud-node-ui">
          <PanelsTopLeft />
          <span>shell</span>
        </div>
      </div>

      <div className="docs-cloud-copy">
        <p className="text-sm font-semibold text-[var(--ember)]">Why Matrix</p>
        <h2 id="matrix-cloud-title">Your cloud computer should stay awake, remember context, and move with you.</h2>
        <p>
          Local development keeps asking the wrong machine to do the work. Matrix gives developers a persistent computer in the cloud so agents, terminals, previews, and context keep running without laptop sleep hacks or keep-awake apps.
        </p>
        <div className="docs-cloud-reasons">
          {reasons.map((reason) => {
            const Icon = reason.icon;

            return (
              <div key={reason.title} className="docs-cloud-reason">
                <Icon />
                <div>
                  <h3>{reason.title}</h3>
                  <p>{reason.body}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

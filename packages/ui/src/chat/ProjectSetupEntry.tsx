import { useState } from "react";
import type { ProjectSetupController } from "./use-project-setup.js";
import { ProjectSetupActionButton as Action, borderStyle, mutedStyle } from "./ProjectSetupAction.js";
import { ProjectSetupProgress } from "./ProjectSetupProgress.js";

export function ProjectSetupEntry({ onStart, pending = false }: { onStart: () => void; pending?: boolean }) {
  const [collapsed, setCollapsed] = useState(false);
  const startButton = (
    <Action variant="primary" disabled={pending} onClick={onStart}>
      Set up with Chat
    </Action>
  );
  if (collapsed) return <div className="my-3">{startButton}</div>;
  return (
    <div
      className="my-3 min-w-0 space-y-5 rounded-xl border p-4 sm:p-5"
      style={borderStyle}
    >
      <div className="min-w-0">
        <p className="text-lg font-semibold leading-snug">Tell the AI how you work</p>
        <p className="mt-1 text-sm" style={mutedStyle}>
          Add project guidance or create a skill you can reuse.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {startButton}
        <Action variant="ghost" disabled={pending} onClick={() => setCollapsed(true)}>
          Skip for now
        </Action>
      </div>
    </div>
  );
}

export function ProjectSetupIntroduction({
  projectName,
  setup,
}: {
  projectName: string;
  setup: ProjectSetupController;
}) {
  return (
    <div
      className="mx-auto w-full max-w-[768px] space-y-7 px-6 py-8 text-sm leading-5"
      data-slot="project-setup-introduction"
    >
      <ProjectSetupProgress projectName={projectName} />
      <div className="space-y-2.5" data-slot="project-setup-first-reply">
        <p>What are you using {projectName} for?</p>
        <p>Pick a starting point or tell me in your own words.</p>
        <div className="flex flex-wrap gap-2">
          {["A portfolio site", "Documentation", "An internal tool"].map((text) => (
            <Action
              key={text}
              disabled={setup.pending}
              onClick={() => {
                void setup.answer(text);
              }}
            >
              {text}
            </Action>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs" style={mutedStyle}>
          <Action variant="ghost" disabled={setup.pending} onClick={setup.dismiss}>
            Skip for now
          </Action>
          <span>You can come back to setup from this project.</span>
        </div>
      </div>
      {setup.error ? (
        <div className="mt-3 space-y-2">
          <p className="text-xs" role="alert">
            {setup.error}
          </p>
          <Action
            disabled={setup.pending}
            onClick={() => {
              void setup.start();
            }}
          >
            Try again
          </Action>
        </div>
      ) : null}
    </div>
  );
}

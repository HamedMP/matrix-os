import { useState } from "react";
import type { ProjectSetupController } from "./use-project-setup.js";
import { ProjectSetupActionButton as Action, borderStyle, mutedStyle } from "./ProjectSetupAction.js";

export function ProjectSetupEntry({ onStart, pending = false }: { onStart: () => void; pending?: boolean }) {
  const [collapsed, setCollapsed] = useState(false);
  if (collapsed)
    return (
      <div className="my-3">
        <Action disabled={pending} onClick={onStart}>
          Set up with Chat
        </Action>
      </div>
    );
  return (
    <div
      className="my-3 flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl border p-3"
      style={borderStyle}
    >
      <div className="min-w-0">
        <p className="text-sm font-medium">Help AI understand your project</p>
        <p className="mt-1 text-xs" style={mutedStyle}>
          Set guidance, add a reusable skill, and connect the tools you use.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Action disabled={pending} onClick={onStart}>
          Set up with Chat
        </Action>
        <Action disabled={pending} onClick={() => setCollapsed(true)}>
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
      className="mx-auto w-full max-w-[808px] px-6 py-8 text-sm leading-[21px]"
      data-slot="project-setup-introduction"
    >
      <p>What are you using {projectName} for?</p>
      <p className="mt-2" style={mutedStyle}>
        Pick a starting point or tell me in your own words.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {["A website or app", "Research and writing", "A team workflow"].map((text) => (
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
      <div className="mt-4">
        <Action disabled={setup.pending} onClick={setup.dismiss}>
          Skip for now
        </Action>
      </div>
      <p className="mt-2 text-xs" style={mutedStyle}>
        You can come back to setup from this project.
      </p>
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


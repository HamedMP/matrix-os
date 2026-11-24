import { useState } from "react";
import type { ProjectSetupController } from "./use-project-setup.js";
import { ProjectSetupActionButton as Action, borderStyle, mutedStyle } from "./ProjectSetupAction.js";

export function ProjectSetupEntry({ onStart, pending = false }: { onStart: () => void; pending?: boolean }) {
  const [collapsed, setCollapsed] = useState(false);
  const startButton = (
    <Action variant="primary" disabled={pending} onClick={onStart}>
      Set up with Chat
    </Action>
  );
  if (collapsed) return <div className="my-3">{startButton}</div>;
  return (
    <div className="my-3 min-w-0 space-y-5 rounded-xl border p-4 sm:p-5" style={borderStyle}>
      <div className="min-w-0">
        <p className="text-lg font-semibold leading-snug">Tell the AI how you work</p>
        <p className="mt-1 text-sm" style={mutedStyle}>
          Set project instructions, add reusable skills, or connect tools.
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

export function ProjectSetupIntroduction({ setup }: { setup: ProjectSetupController }) {
  if (setup.error) {
    return (
      <div className="space-y-2">
        <p className="text-sm" role="alert">{setup.error}</p>
        <div className="flex flex-wrap gap-2">
          <Action disabled={setup.pending} onClick={() => { void setup.start(); }}>
            Try again
          </Action>
          <Action variant="ghost" onClick={setup.dismiss}>Skip for now</Action>
        </div>
      </div>
    );
  }
  return <p className="text-sm" role="status" style={mutedStyle}>Preparing the first question…</p>;
}

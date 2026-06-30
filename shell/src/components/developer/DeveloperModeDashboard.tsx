"use client";

import { useState } from "react";
import { CheckCircle2Icon, ClipboardIcon, GitBranchIcon, TerminalIcon } from "lucide-react";

export const DEVELOPER_SETUP_PROMPT = `Set up Matrix OS as my remote developer computer.

Install or verify the Matrix CLI, run matrix login, and wait for the browser/device approval to finish. When my Matrix computer is ready, open a persistent setup terminal with matrix run -it --session setup -- gh auth login. Authenticate GitHub in the browser, create or use a Matrix-managed SSH key inside Matrix, clone my repository, and start my preferred coding agent inside Matrix.

Do not upload local private keys, scan my laptop for secrets, or paste credentials into Matrix. Ask me before checkout, browser approvals, SSH key unlocks, or coding-agent authorization.`;

interface DeveloperModeDashboardProps {
  setupPrompt?: string;
  onOpenTerminal: () => void;
  onSwitchCanvas: () => void;
}

const SETUP_STEPS = [
  "Account and plan approved",
  "Matrix computer ready",
  "GitHub browser login",
  "Matrix-managed SSH key",
  "Repository cloned",
  "Coding agent running",
] as const;

export function DeveloperModeDashboard({
  setupPrompt = DEVELOPER_SETUP_PROMPT,
  onOpenTerminal,
  onSwitchCanvas,
}: DeveloperModeDashboardProps) {
  const [copied, setCopied] = useState(false);

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(setupPrompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (err: unknown) {
      console.warn("[DeveloperModeDashboard] clipboard write failed:", err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="absolute inset-0 z-10 overflow-auto bg-[#080a0f] text-white">
      <div className="mx-auto grid min-h-full max-w-7xl gap-6 px-5 py-6 lg:grid-cols-[320px_minmax(0,1fr)] lg:px-8">
        <aside className="rounded-3xl border border-white/10 bg-white/[0.04] p-5 shadow-2xl shadow-black/30">
          <p className="mb-2 text-xs font-medium uppercase tracking-[0.28em] text-amber-200/70">Developer Fast Path</p>
          <h1 className="text-3xl font-semibold tracking-tight">Developer mode</h1>
          <p className="mt-3 text-sm leading-6 text-white/64">
            Terminal is the primary surface. Bring your coding agent into the Matrix computer once the runtime and repo are ready.
          </p>
          <ol className="mt-6 grid gap-3 text-sm">
            {SETUP_STEPS.map((step, index) => (
              <li key={step} className="flex items-center gap-3 rounded-2xl border border-white/8 bg-black/20 px-3 py-2.5 text-white/78">
                <span className="grid size-7 place-items-center rounded-full bg-amber-300/12 text-xs font-semibold text-amber-100">
                  {index + 1}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </aside>

        <main className="grid content-start gap-5">
          <div className="rounded-[2rem] border border-amber-200/20 bg-[radial-gradient(circle_at_top_left,rgba(250,204,21,0.18),transparent_34%),linear-gradient(135deg,rgba(255,255,255,0.1),rgba(255,255,255,0.03))] p-5 shadow-2xl shadow-black/30 md:p-7">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
              <div className="max-w-2xl">
                <p className="text-sm font-medium text-amber-100/80">Start here</p>
                <h2 className="mt-2 text-3xl font-semibold tracking-tight md:text-5xl">Get to a remote coding session.</h2>
                <p className="mt-4 max-w-xl text-base leading-7 text-white/68">
                  Copy the setup prompt into your local agent, or open Terminal and run the GitHub auth step directly inside Matrix.
                </p>
              </div>
              <div className="grid gap-2 lg:min-w-[320px]">
                <button
                  type="button"
                  onClick={onOpenTerminal}
                  className="inline-flex items-center justify-center gap-2 rounded-2xl bg-amber-200 px-4 py-3 text-sm font-semibold text-black transition hover:bg-amber-100"
                >
                  <TerminalIcon className="size-4" aria-hidden="true" />
                  Open Terminal
                </button>
              </div>
            </div>
          </div>

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
            <article className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-medium uppercase tracking-[0.2em] text-white/40">Agent setup prompt</p>
                  <h3 className="mt-1 text-xl font-semibold">Bring your own coding agent</h3>
                </div>
                <button
                  type="button"
                  onClick={() => void copyPrompt()}
                  className="inline-flex shrink-0 items-center gap-2 rounded-full border border-white/12 px-3 py-2 text-xs font-medium text-white/72 transition hover:bg-white/10 hover:text-white"
                >
                  <ClipboardIcon className="size-3.5" aria-hidden="true" />
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <textarea
                readOnly
                value={setupPrompt}
                className="min-h-56 w-full resize-none rounded-2xl border border-white/10 bg-black/38 p-4 font-mono text-sm leading-6 text-emerald-50/88 outline-none"
                aria-label="Developer setup prompt"
              />
            </article>

            <aside className="grid content-start gap-3 rounded-[2rem] border border-white/10 bg-white/[0.04] p-5">
              <div className="flex items-start gap-3 rounded-2xl bg-emerald-300/10 p-3 text-sm leading-6 text-emerald-50/82">
                <CheckCircle2Icon className="mt-1 size-4 shrink-0 text-emerald-200" aria-hidden="true" />
                <p>Use a Matrix-managed SSH key. Do not upload local private keys.</p>
              </div>
              <div className="flex items-start gap-3 rounded-2xl bg-sky-300/10 p-3 text-sm leading-6 text-sky-50/82">
                <GitBranchIcon className="mt-1 size-4 shrink-0 text-sky-200" aria-hidden="true" />
                <p>GitHub and coding-agent auth happen through browser approvals owned by you.</p>
              </div>
              <button
                type="button"
                onClick={onSwitchCanvas}
                className="mt-2 rounded-2xl border border-white/12 px-4 py-3 text-sm font-semibold text-white/72 transition hover:bg-white/10 hover:text-white"
              >
                Switch to Canvas
              </button>
            </aside>
          </div>
        </main>
      </div>
    </section>
  );
}

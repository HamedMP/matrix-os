"use client";

import { useState } from "react";
import Image from "next/image";
import { Loader2Icon, ServerIcon } from "lucide-react";

import {
  defaultDeveloperTools,
  developerToolOptions,
  nextDeveloperToolsSelection,
  type DeveloperToolId,
} from "./developer-tools";

function DeveloperToolLogo({ logoPath }: { logoPath: string }) {
  return (
    <span
      className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-white/15 bg-[#2F392C] p-1.5 shadow-sm"
      aria-hidden="true"
    >
      <Image src={logoPath} alt="" width={20} height={20} className="size-full object-contain" draggable={false} />
    </span>
  );
}

export function DeveloperToolsSelector({
  selectedTools,
  onToggle,
}: {
  selectedTools: DeveloperToolId[];
  onToggle: (tool: DeveloperToolId) => void;
}) {
  return (
    <section className="rounded-[22px] border border-forest/12 bg-white p-3 sm:p-3.5">
      <div className="mb-3 flex flex-col gap-1 px-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <h4 className="text-sm font-semibold text-deep">Developer tools</h4>
        <p className="text-xs text-forest/45">Choose command-line agents to preinstall on this VPS.</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {developerToolOptions.map((tool) => {
          const checked = selectedTools.includes(tool.id);
          return (
            <label
              key={tool.id}
              className={`flex min-h-16 cursor-pointer items-center justify-between rounded-xl border px-3 py-2.5 transition-all ${
                checked
                  ? "border-ember bg-[#fff7ec] shadow-[0_10px_24px_rgba(83,68,48,0.10)]"
                  : "border-forest/10 bg-white hover:border-forest/25"
              }`}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <DeveloperToolLogo logoPath={tool.logoPath} />
                <span className="block truncate text-sm font-medium text-deep">{tool.label}</span>
              </span>
              <input
                type="checkbox"
                aria-label={tool.label}
                checked={checked}
                onChange={() => onToggle(tool.id)}
                className="size-4 accent-ember"
              />
            </label>
          );
        })}
      </div>
    </section>
  );
}

export function DefaultInstallsStep({
  onBuild,
  loading = false,
  error = null,
}: {
  onBuild: (tools: DeveloperToolId[]) => void;
  loading?: boolean;
  error?: string | null;
}) {
  const [selectedTools, setSelectedTools] = useState<DeveloperToolId[]>(defaultDeveloperTools);

  function toggleTool(tool: DeveloperToolId): void {
    setSelectedTools((current) => nextDeveloperToolsSelection(current, tool));
  }

  return (
    <div className="flex w-full max-w-4xl flex-col gap-4 text-left">
      <section className="rounded-[22px] border border-forest/15 bg-[#fbf7ed] p-4 shadow-[0_24px_80px_rgba(50,53,46,0.12)] sm:p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-forest/60">Default installs</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-deep sm:text-3xl">
          Choose what Matrix installs first
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-forest/70">
          Choose command-line agents to preinstall on this VPS.
        </p>
      </section>

      <DeveloperToolsSelector selectedTools={selectedTools} onToggle={toggleTool} />

      {error ? (
        <p className="rounded-xl border border-ember/25 bg-ember/10 px-3 py-2 text-sm text-deep" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-forest/55">
          CLI login happens after the VPS is ready. Tool authentication is completed inside each CLI.
        </p>
        <button
          type="button"
          onClick={() => onBuild(selectedTools)}
          disabled={loading}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-forest px-5 text-sm font-semibold text-white shadow-[0_14px_30px_rgba(63,74,58,0.18)] transition hover:bg-forest/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? (
            <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <ServerIcon className="size-4" aria-hidden="true" />
          )}
          Build VPS
        </button>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { CheckIcon, Loader2Icon, ServerIcon } from "lucide-react";
import { MATRIX_TELEMETRY_EVENTS } from "@matrix-os/observability/events";

import {
  capturePostHogEvent,
  setPostHogPersonPropertiesOnce,
} from "@/lib/posthog-client";

import {
  defaultDeveloperTools,
  developerToolOptions,
  nextDeveloperToolsSelection,
  type DeveloperToolId,
} from "./developer-tools";

const ACQUISITION_QUESTION_ID = "acquisition_source_v1";
const ACQUISITION_SURFACE = "settings_default_installs";

const acquisitionSourceOptions = [
  { id: "tiktok", label: "TikTok" },
  { id: "instagram", label: "Instagram" },
  { id: "youtube", label: "YouTube" },
  { id: "x_twitter", label: "X / Twitter" },
  { id: "reddit", label: "Reddit" },
  { id: "google_search", label: "Google / Search" },
  { id: "friend_or_colleague", label: "A friend or colleague" },
  { id: "other", label: "Other" },
] as const;

type AcquisitionSource = typeof acquisitionSourceOptions[number]["id"];

function AcquisitionSourceStep({ onContinue }: { onContinue: () => void }) {
  const [selectedSource, setSelectedSource] = useState<AcquisitionSource | null>(null);

  useEffect(() => {
    capturePostHogEvent(MATRIX_TELEMETRY_EVENTS.ONBOARDING_ACQUISITION_SOURCE_VIEWED, {
      question_id: ACQUISITION_QUESTION_ID,
      surface: ACQUISITION_SURFACE,
    });
  }, []);

  function submitSource(): void {
    if (!selectedSource) return;
    capturePostHogEvent(MATRIX_TELEMETRY_EVENTS.ONBOARDING_ACQUISITION_SOURCE_SUBMITTED, {
      question_id: ACQUISITION_QUESTION_ID,
      source: selectedSource,
      surface: ACQUISITION_SURFACE,
    });
    setPostHogPersonPropertiesOnce({
      acquisition_source: selectedSource,
      acquisition_source_question: ACQUISITION_QUESTION_ID,
    });
    onContinue();
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 p-4 text-left sm:p-6">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ember">One quick question</p>
        <h2 className="mt-2 text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
          How did you hear about Matrix?
        </h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
          This helps us understand which communities are bringing people into Matrix OS.
        </p>
      </header>

      <fieldset>
        <legend className="sr-only">Choose where you first heard about Matrix</legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {acquisitionSourceOptions.map((option) => {
            const selected = selectedSource === option.id;
            return (
              <label
                key={option.id}
                className={`flex min-h-14 cursor-pointer items-center justify-between rounded-xl border px-4 py-3 text-sm font-medium transition-all ${
                  selected
                    ? "border-ember bg-ember/10 text-deep shadow-[0_10px_24px_rgba(83,68,48,0.08)]"
                    : "border-border/70 bg-background/55 text-foreground hover:border-forest/30 hover:bg-background"
                }`}
              >
                <span>{option.label}</span>
                <input
                  type="radio"
                  name="acquisition-source"
                  value={option.id}
                  checked={selected}
                  onChange={() => setSelectedSource(option.id)}
                  className="sr-only"
                />
                <span
                  className={`flex size-5 items-center justify-center rounded-full border ${
                    selected ? "border-ember bg-ember text-white" : "border-forest/25 bg-white"
                  }`}
                  aria-hidden="true"
                >
                  {selected ? <CheckIcon className="size-3.5" /> : null}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={submitSource}
          disabled={!selectedSource}
          className="inline-flex h-11 items-center justify-center rounded-xl bg-forest px-6 text-sm font-semibold text-white shadow-[0_14px_30px_rgba(63,74,58,0.18)] transition hover:bg-forest/90 disabled:cursor-not-allowed disabled:opacity-45"
        >
          Continue
        </button>
      </div>
    </div>
  );
}

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
  // The selector is bounded to the four supported developer tools.
  const selectedToolIds = new Set(selectedTools);

  return (
    <section className="rounded-2xl border border-border/70 bg-background/55 p-3 sm:p-4">
      <div className="mb-3 flex flex-col gap-1 px-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <h4 className="text-sm font-semibold text-deep">Developer tools</h4>
        <p className="text-xs text-forest/45">Choose command-line agents to preinstall on this VPS.</p>
      </div>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
        {developerToolOptions.map((tool) => {
          const checked = selectedToolIds.has(tool.id);
          return (
            <label
              key={tool.id}
              className={`flex min-h-14 cursor-pointer items-center justify-between rounded-xl border px-3 py-2 transition-all sm:min-h-16 sm:py-2.5 ${
                checked
                  ? "border-ember bg-[#fff7ec] shadow-[0_10px_24px_rgba(83,68,48,0.10)]"
                  : "border-forest/10 bg-white hover:border-forest/25"
              }`}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2.5">
                <DeveloperToolLogo logoPath={tool.logoPath} />
                <span className="block min-w-0 whitespace-normal break-words text-sm font-medium leading-5 text-deep">
                  {tool.label}
                </span>
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
  collectAcquisitionSource = false,
}: {
  onBuild: (tools: DeveloperToolId[]) => void;
  loading?: boolean;
  error?: string | null;
  collectAcquisitionSource?: boolean;
}) {
  const [step, setStep] = useState<"acquisition" | "installs">(
    collectAcquisitionSource ? "acquisition" : "installs",
  );
  const [selectedTools, setSelectedTools] = useState<DeveloperToolId[]>(defaultDeveloperTools);

  function toggleTool(tool: DeveloperToolId): void {
    setSelectedTools((current) => nextDeveloperToolsSelection(current, tool));
  }

  if (step === "acquisition") {
    return <AcquisitionSourceStep onContinue={() => setStep("installs")} />;
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 text-left sm:gap-5 sm:p-6">
      <header>
        <h2 className="text-lg font-semibold text-foreground">Default installs</h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
          Choose the coding agents Matrix should preinstall. You can select any combination, including none.
        </p>
      </header>

      <DeveloperToolsSelector selectedTools={selectedTools} onToggle={toggleTool} />

      {error ? (
        <p className="rounded-xl border border-ember/25 bg-ember/10 px-3 py-2 text-sm text-deep" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-forest/55">
          You can install or sign into agents anytime from the terminal’s + menu after the VPS is ready.
        </p>
        <button
          type="button"
          onClick={() => onBuild(selectedTools)}
          disabled={loading}
          aria-busy={loading}
          className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-forest px-5 text-sm font-semibold text-white shadow-[0_14px_30px_rgba(63,74,58,0.18)] transition hover:bg-forest/90 disabled:cursor-not-allowed disabled:opacity-60"
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

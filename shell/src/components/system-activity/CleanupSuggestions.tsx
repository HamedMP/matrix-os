"use client";

import { Play, Sparkles } from "lucide-react";
import type { ActivitySnapshot } from "@/stores/systemActivityStore";

interface CleanupSuggestionsProps {
  suggestions: ActivitySnapshot["cleanupSuggestions"];
  cleanupStatus: "idle" | "running" | "success" | "error";
  onRun: (candidateId: string) => Promise<void>;
}

export function CleanupSuggestions({ suggestions, cleanupStatus, onRun }: CleanupSuggestionsProps) {
  if (suggestions.length === 0) {
    return (
      <div className="grid min-h-[120px] place-items-center rounded-md bg-emerald-50 text-center dark:bg-emerald-950/30">
        <div>
          <Sparkles className="mx-auto mb-2 size-5 text-emerald-600 dark:text-emerald-300" />
          <p className="text-sm font-medium">No stale cleanup targets</p>
          <p className="mt-1 text-xs text-emerald-800/70 dark:text-emerald-100/70">Current snapshot is clean.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {suggestions.map((candidate) => (
        <div key={candidate.candidateId} className="grid gap-3 rounded-md border border-black/10 bg-[#f7f9fb] p-3 dark:border-white/10 dark:bg-white/5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{candidate.targetLabel}</p>
              <p className="mt-1 line-clamp-2 text-xs text-[#687082] dark:text-[#98a1b2]">{candidate.reason}</p>
            </div>
            <span className={`shrink-0 rounded-md px-2 py-1 text-xs font-medium ${riskBadgeClass(candidate.risk)}`}>
              {candidate.risk} risk
            </span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-[#687082] dark:text-[#98a1b2]">
              {candidate.estimatedReclaimBytes ? `${formatBytes(candidate.estimatedReclaimBytes)} reclaim` : "Manual review"}
            </span>
            <button
              type="button"
              onClick={() => void onRun(candidate.candidateId)}
              disabled={cleanupStatus === "running"}
              className="inline-flex h-8 items-center gap-2 rounded-md bg-[#1f2937] px-3 text-xs font-semibold text-white transition hover:bg-[#111827] disabled:opacity-60 dark:bg-[#e7edf7] dark:text-[#11151d] dark:hover:bg-white"
            >
              <Play className="size-3.5" />
              Clean
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function riskBadgeClass(risk: ActivitySnapshot["cleanupSuggestions"][number]["risk"]): string {
  if (risk === "high") return "bg-red-100 text-red-900 dark:bg-red-400/15 dark:text-red-100";
  if (risk === "medium") return "bg-amber-100 text-amber-900 dark:bg-amber-400/15 dark:text-amber-100";
  return "bg-emerald-100 text-emerald-900 dark:bg-emerald-400/15 dark:text-emerald-100";
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

"use client";

import { AlertTriangleIcon, BookOpenTextIcon, LinkIcon } from "lucide-react";

export interface CompanyBrainReadiness {
  status: "needs_context" | "ready" | "needs_review";
  guidance: string;
  items: Array<{
    id: string;
    type: string;
    title: string;
    summary: string;
    source: string;
    visibility: "owner_only" | "authorized_teammates";
    updatedAt: string;
  }>;
  sourceLinks: string[];
  reviewFlags: Array<{ itemId: string; kind: "stale" | "contradiction"; message: string }>;
}

export function CompanyBrainPanel({ readiness }: { readiness: CompanyBrainReadiness | null }) {
  if (!readiness) return null;

  return (
    <section className="rounded-md border border-[#17281f]/10 bg-[#f8f5ee]/80 p-4 shadow-[0_16px_45px_rgba(23,40,31,0.08)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-[#111612]">
            <BookOpenTextIcon className="h-4 w-4 text-[#a6542f]" aria-hidden="true" />
            Company brain
          </h2>
          <p className="mt-1 max-w-xl text-xs leading-5 text-[#17281f]/62">{readiness.guidance}</p>
        </div>
        <span className="rounded-full border border-[#17281f]/10 bg-white/60 px-2.5 py-1 text-xs font-medium capitalize text-[#17281f]/70">
          {readiness.status.replaceAll("_", " ")}
        </span>
      </div>

      {readiness.items.length > 0 ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {readiness.items.slice(0, 4).map((item) => (
            <div key={item.id} className="rounded-md border border-[#17281f]/10 bg-white/60 p-3">
              <p className="text-xs font-semibold text-[#111612]">{item.title}</p>
              <p className="mt-1 line-clamp-2 text-xs leading-5 text-[#17281f]/62">{item.summary}</p>
              <p className="mt-2 inline-flex items-center gap-1 text-xs text-[#17281f]/55">
                <LinkIcon className="h-3.5 w-3.5" aria-hidden="true" />
                {item.source}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-3 rounded-md border border-dashed border-[#17281f]/15 bg-white/45 p-3 text-xs text-[#17281f]/60">
          Add a decision, customer note, support thread, or project record to make Matrix answers source-aware.
        </div>
      )}

      {readiness.reviewFlags.length > 0 && (
        <div className="mt-3 rounded-md border border-[#b4532f]/20 bg-[#b4532f]/10 p-3">
          <p className="flex items-center gap-2 text-xs font-semibold text-[#5f2b1e]">
            <AlertTriangleIcon className="h-4 w-4" aria-hidden="true" />
            Review context
          </p>
          <div className="mt-2 space-y-1">
            {readiness.reviewFlags.slice(0, 3).map((flag) => (
              <p key={`${flag.itemId}-${flag.kind}`} className="text-xs leading-5 text-[#5f2b1e]/80">
                {flag.message}
              </p>
            ))}
          </div>
        </div>
      )}

      {readiness.sourceLinks.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {readiness.sourceLinks.slice(0, 6).map((source) => (
            <span key={source} className="rounded-full border border-[#17281f]/10 bg-white/60 px-2.5 py-1 text-xs text-[#17281f]/60">
              {source}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

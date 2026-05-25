"use client";

import { AlertTriangleIcon, MegaphoneIcon, SendIcon } from "lucide-react";

export interface DraftActionReadiness {
  status: "ready" | "needs_review";
  pendingReview: number;
  approved: number;
  guidance: string;
  drafts: Array<{
    id: string;
    type: string;
    status: string;
    content: string;
    destination: string;
    uncertainties: Array<{ kind: "uncertainty" | "sensitive_claim"; message: string }>;
    createdByAgent: "claude" | "codex" | "hermes";
    createdAt: string;
  }>;
}

export function SupportGrowthPanel({
  readiness,
  onApprove,
}: {
  readiness: DraftActionReadiness | null;
  onApprove: (draftId: string) => void;
}) {
  if (!readiness || readiness.drafts.length === 0) return null;
  const visibleDrafts = [
    ...readiness.drafts.filter((draft) => draft.status === "needs_review"),
    ...readiness.drafts.filter((draft) => draft.status !== "needs_review"),
  ].slice(0, 3);

  return (
    <section className="rounded-md border border-[#17281f]/10 bg-[#f8f5ee]/80 p-4 shadow-[0_16px_45px_rgba(23,40,31,0.08)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-[#111612]">
            <MegaphoneIcon className="h-4 w-4 text-[#a6542f]" aria-hidden="true" />
            Support and growth
          </h2>
          <p className="mt-1 max-w-xl text-xs leading-5 text-[#17281f]/62">{readiness.guidance}</p>
        </div>
        <span className="rounded-full border border-[#17281f]/10 bg-white/60 px-2.5 py-1 text-xs font-medium capitalize text-[#17281f]/70">
          {readiness.pendingReview} pending
        </span>
      </div>

      <div className="mt-3 grid gap-2">
        {visibleDrafts.map((draft) => (
          <div key={draft.id} className="rounded-md border border-[#17281f]/10 bg-white/60 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold capitalize text-[#111612]">{draft.type.replaceAll("_", " ")}</p>
                <p className="mt-1 text-xs text-[#17281f]/55">{draft.destination}</p>
              </div>
              {draft.status === "needs_review" ? (
                // Rejection is supported by the service but intentionally deferred
                // from this compact beta panel until the review workflow has room.
                <button
                  type="button"
                  onClick={() => onApprove(draft.id)}
                  className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-[#17281f]/12 bg-[#f8f5ee]/85 px-2.5 text-xs font-medium text-[#17281f]"
                >
                  <SendIcon className="h-3.5 w-3.5" aria-hidden="true" />
                  Approve draft
                </button>
              ) : (
                <span className="rounded-full border border-[#17281f]/10 bg-[#f8f5ee]/75 px-2.5 py-1 text-xs font-medium capitalize text-[#17281f]/70">
                  {draft.status.replaceAll("_", " ")}
                </span>
              )}
            </div>
            <p className="mt-2 text-xs leading-5 text-[#17281f]/68">{draft.content}</p>
            {draft.uncertainties.length > 0 && (
              <div className="mt-2 rounded-md border border-[#b4532f]/20 bg-[#b4532f]/10 p-2">
                {draft.uncertainties.map((uncertainty) => (
                  <p key={`${draft.id}-${uncertainty.kind}-${uncertainty.message}`} className="flex items-center gap-1.5 text-xs leading-5 text-[#5f2b1e]">
                    <AlertTriangleIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    {uncertainty.message}
                  </p>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

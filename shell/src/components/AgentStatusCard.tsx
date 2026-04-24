"use client";

interface AgentStatusCardProps {
  visible: boolean;
  /** Short uppercase label, e.g. "WORKING", "BUILDING", or current tool name. */
  stage: string;
  /** Optional secondary line under the progress bar. */
  description?: string;
  /** Optional progress data. When provided, renders a progress bar + remaining time. */
  progress?: {
    elapsedSec: number;
    estimatedTotalSec: number;
  };
  /** Distance from the top of the viewport in rem. Default 2.5. Vocal mode
      passes larger values when its delegation banner / remembered flash is
      stacked above. */
  topOffsetRem?: number;
}

/**
 * Top-centered glass card that surfaces "what the agent is doing right now".
 * Used by both the vocal-mode build progress flow and the chat busy
 * indicator. Visual: primary-tinted dark glass + primary border + bloom
 * shadow, Inter uppercase stage label, optional progress bar, optional
 * description. Auto-hides via opacity + translateY transition.
 */
export function AgentStatusCard({
  visible,
  stage,
  description,
  progress,
  topOffsetRem = 2.5,
}: AgentStatusCardProps) {
  const remainingSec = progress
    ? Math.max(0, progress.estimatedTotalSec - progress.elapsedSec)
    : null;
  const progressFraction = progress
    ? Math.min(progress.elapsedSec / progress.estimatedTotalSec, 0.95)
    : null;

  return (
    <div
      className="fixed inset-x-0 flex justify-center transition-all duration-500 pointer-events-none z-40"
      style={{
        top: `${topOffsetRem}rem`,
        opacity: visible ? 1 : 0,
        transform: `translateY(${visible ? 0 : -6}px)`,
      }}
      aria-hidden={!visible}
    >
      <div
        className="flex flex-col gap-2.5 px-5 py-3.5 rounded-2xl backdrop-blur-md min-w-[280px] max-w-[380px]"
        style={{
          background: "color-mix(in srgb, var(--primary) 18%, rgba(0,0,0,0.55))",
          border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)",
          boxShadow:
            "0 4px 24px rgba(0,0,0,0.4), 0 0 40px color-mix(in srgb, var(--primary) 20%, transparent)",
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <span
            className="text-[10px] uppercase tracking-[0.25em]"
            style={{
              color: "#ffffff",
              fontFamily: "var(--font-inter), system-ui, sans-serif",
            }}
          >
            {stage}
          </span>
          {remainingSec !== null && (
            <span
              className="text-[10px] tabular-nums"
              style={{
                color: "rgba(255,255,255,0.65)",
                fontFamily: "var(--font-inter), system-ui, sans-serif",
              }}
            >
              ~{remainingSec}s remaining
            </span>
          )}
        </div>

        {progressFraction !== null && (
          <div
            className="w-full h-1.5 rounded-full overflow-hidden"
            style={{ background: "rgba(255,255,255,0.12)" }}
          >
            <div
              className="h-full rounded-full transition-all duration-700 ease-out"
              style={{
                width: `${progressFraction * 100}%`,
                background:
                  "linear-gradient(90deg, var(--primary), color-mix(in srgb, var(--primary) 70%, white))",
                boxShadow:
                  "0 0 8px color-mix(in srgb, var(--primary) 60%, transparent)",
              }}
            />
          </div>
        )}

        {/* Indeterminate shimmer when busy but no progress data (chat flow) */}
        {progressFraction === null && (
          <div
            className="w-full h-1 rounded-full overflow-hidden"
            style={{ background: "rgba(255,255,255,0.10)" }}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: "30%",
                background:
                  "linear-gradient(90deg, transparent, var(--primary), transparent)",
                animation: "agent-status-shimmer 1.6s ease-in-out infinite",
              }}
            />
          </div>
        )}

        {description && (
          <span
            className="text-xs truncate"
            style={{
              color: "rgba(255,255,255,0.7)",
              fontFamily: "var(--font-inter), system-ui, sans-serif",
            }}
          >
            {description}
          </span>
        )}
      </div>
    </div>
  );
}

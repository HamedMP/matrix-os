import { useEffect, useRef, useState } from "react";
import type { CanonicalChatApprovalDecision } from "@matrix-os/contracts";
import { supervisedToolRetryPrompt, type SupervisedToolApproval } from "@matrix-os/contracts";

const warning = "var(--surface-warning-emphasis, var(--warning, #e0aa52))";
const ink = "var(--text-primary, #171717)";
const paper = "var(--bg-overlay, #fff)";
const sunken = "var(--bg-sunken, #f3f2f0)";
const muted = "var(--text-secondary, #6e6969)";
const line = "var(--border-default, #e5e5e5)";

const buttonBase = {
  height: 28,
  borderRadius: 10,
  padding: "0 10px",
  fontSize: 13,
  fontWeight: 500,
  lineHeight: "20px",
} as const;

function Dot() {
  return <span aria-hidden style={{ width: 7, height: 7, borderRadius: 999, background: warning, flex: "0 0 auto" }} />;
}

export function SupervisedToolApprovalBar({
  label,
  onReview,
}: {
  label: string;
  onReview?: () => void;
}) {
  return (
    <div
      className="mb-2 flex h-9 items-center gap-2 rounded-[10px] border py-1.5 pl-3 pr-1.5"
      style={{ borderColor: warning, background: `color-mix(in srgb, ${warning} 16%, ${paper})` }}
    >
      <Dot />
      <p className="min-w-0 flex-1 truncate text-[13px] font-medium" style={{ color: ink }}>{label}</p>
      {onReview ? (
        <button type="button" className="h-6 rounded-[10px] px-2 text-[13px] font-medium" style={{ color: ink }} onClick={onReview}>
          Review
        </button>
      ) : null}
    </div>
  );
}

function AccessMenu({
  mode,
  onSelect,
}: {
  mode: string | undefined;
  onSelect: (mode: "supervised" | "full_access") => void;
}) {
  const options = [
    { value: "supervised" as const, title: "Supervised", body: "Asks before using tools like web search." },
    { value: "full_access" as const, title: "Full access", body: "Uses tools without asking. Switch back anytime." },
  ];
  const selectedRef = useRef<HTMLButtonElement>(null);
  // Focus enters the menu on open, landing on the current mode (UX guide).
  useEffect(() => { selectedRef.current?.focus(); }, []);
  const current = mode === "full_access" ? "full_access" : "supervised";
  return (
    <div role="menu" aria-label="Permission mode" className="absolute bottom-8 right-0 z-10 w-[280px] rounded-xl border p-1.5 shadow-lg" style={{ borderColor: line, background: paper }}>
      {options.map((option) => {
        const selected = (mode ?? "supervised") === option.value;
        return (
          <button
            key={option.value}
            ref={option.value === current ? selectedRef : undefined}
            type="button"
            role="menuitemradio"
            aria-checked={selected}
            className="flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left"
            onClick={() => onSelect(option.value)}
          >
            <span aria-hidden className="mt-1 size-3 rounded-full border" style={{ borderColor: selected ? ink : line, background: selected ? ink : "transparent" }} />
            <span>
              <span className="block text-[13px] font-medium" style={{ color: ink }}>{option.title}</span>
              <span className="block text-[12px]" style={{ color: muted }}>{option.body}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function PermissionModeControl({
  mode,
  onSelect,
}: {
  mode: string | undefined;
  onSelect: (mode: "supervised" | "full_access") => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Light dismiss: Escape closes and returns focus; a press outside the trigger and menu closes.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);
  return (
    <div ref={containerRef} className="relative">
      <button ref={triggerRef} type="button" className="h-6 px-2 text-[12px] font-medium" style={{ color: muted }} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((current) => !current)}>
        Always allow → Full access
      </button>
      {open ? <AccessMenu mode={mode} onSelect={(next) => { setOpen(false); triggerRef.current?.focus(); onSelect(next); }} /> : null}
    </div>
  );
}

function SettledApproval({
  approval,
  anchorId,
}: {
  approval: Extract<SupervisedToolApproval, { kind: "allowed" | "declined" | "cancelled" }>;
  anchorId?: string;
}) {
  return (
    <div id={anchorId} className="flex items-center gap-2 text-[13px] font-medium" style={{ color: muted }}>
      <span aria-hidden>{approval.kind === "allowed" ? "✓" : "×"}</span>
      <span>{approval.line}</span>
    </div>
  );
}

export function SupervisedToolApprovalCard({
  approval,
  anchorId,
  submitting = false,
  permissionMode,
  onDecision,
  onPermissionMode,
  onTryAgain,
}: {
  approval: SupervisedToolApproval;
  anchorId?: string;
  submitting?: boolean;
  permissionMode?: string;
  onDecision?: (decision: CanonicalChatApprovalDecision) => void;
  onPermissionMode?: (mode: "supervised" | "full_access") => void;
  onTryAgain?: (prompt: string) => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  if (approval.kind === "allowed" || approval.kind === "declined" || approval.kind === "cancelled") {
    return <SettledApproval approval={approval} anchorId={anchorId} />;
  }
  const expired = approval.kind === "expired";
  return (
    <div id={anchorId} role="group" aria-label={expired ? "Request expired" : "Needs your approval"} className="flex w-full flex-col gap-3.5 rounded-xl border p-4" style={{ borderColor: expired ? line : warning, background: paper }}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {expired ? null : <Dot />}
          <p className="text-[12px] font-medium leading-[18px]" style={{ color: muted }}>{expired ? "Request expired" : "Needs your approval"}</p>
        </div>
        {!expired && approval.details ? (
          <button type="button" className="h-6 px-2 text-[12px] font-medium" style={{ color: muted }} aria-expanded={detailsOpen} onClick={() => setDetailsOpen((open) => !open)}>
            See details
          </button>
        ) : null}
      </div>
      <p className="text-[14px] font-medium leading-[21px]" style={{ color: ink }}>{approval.title}</p>
      <div className="rounded-lg px-3 py-2.5 text-[13px] leading-5" style={{ background: sunken, color: ink }}>
        {approval.summary}
        {detailsOpen && approval.kind === "waiting" && approval.details ? <pre className="mt-2 whitespace-pre-wrap font-sans">{approval.details}</pre> : null}
      </div>
      {approval.kind === "waiting" ? (
        <ApprovalActions approval={approval} submitting={submitting} permissionMode={permissionMode} onDecision={onDecision} onPermissionMode={onPermissionMode} />
      ) : onTryAgain ? (
        <button type="button" className="self-start text-[13px] font-medium underline" style={{ color: ink }} onClick={() => onTryAgain(supervisedToolRetryPrompt(approval.title))}>Try again</button>
      ) : null}
    </div>
  );
}

function ApprovalActions({
  approval,
  submitting,
  permissionMode,
  onDecision,
  onPermissionMode,
}: {
  approval: Extract<SupervisedToolApproval, { kind: "waiting" }>;
  submitting: boolean;
  permissionMode?: string;
  onDecision?: (decision: CanonicalChatApprovalDecision) => void;
  onPermissionMode?: (mode: "supervised" | "full_access") => void;
}) {
  const disabled = submitting || !onDecision;
  // Full access applies from the next request, so it also approves this one; Supervised changes nothing.
  const choosePermission = (mode: "supervised" | "full_access") => {
    if (mode !== "full_access" || !onPermissionMode) return;
    onPermissionMode("full_access");
    if (!disabled && approval.allowOnce) onDecision?.("approve");
  };
  return (
    <div className="relative flex items-center gap-2">
      {approval.allowOnce ? <button type="button" disabled={disabled} style={{ ...buttonBase, background: ink, color: paper }} onClick={() => onDecision?.("approve")}>Allow once</button> : null}
      {approval.decline ? <button type="button" disabled={disabled} style={{ ...buttonBase, background: "transparent", color: ink }} onClick={() => onDecision?.("decline")}>Not now</button> : null}
      <span className="flex-1" />
      {onPermissionMode ? <PermissionModeControl mode={permissionMode} onSelect={choosePermission} /> : null}
    </div>
  );
}

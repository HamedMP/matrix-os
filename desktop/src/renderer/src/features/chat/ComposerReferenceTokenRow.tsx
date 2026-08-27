import { Box, File, FolderOpen, SquareTerminal, X } from "@renderer/lib/hugeicons";
import type { ReactNode } from "react";
import {
  composerReferenceTokenKey,
  type ComposerReferenceToken,
} from "./composer-reference-tokens";

export function ComposerReferenceTokenRow({
  tokens,
  attachments,
  onChange,
  layout = "row",
}: {
  tokens: ComposerReferenceToken[];
  attachments?: ReactNode;
  onChange?: (tokens: ComposerReferenceToken[]) => void;
  layout?: "row" | "inline";
}) {
  if (tokens.length === 0 && !attachments) return null;
  return (
    <div
      className={layout === "inline" ? "contents" : "flex flex-wrap items-center gap-1.5 px-3 pt-3"}
      data-slot={layout === "inline" ? "composer-context-inline" : "composer-context-row"}
    >
      {tokens.map((token) => {
        const key = composerReferenceTokenKey(token);
        const kind = token.type === "invocation" ? token.invocation.kind : token.resource.kind;
        const id = token.type === "invocation" ? token.invocation.descriptorId : token.resource.id;
        const label = token.type === "invocation" ? token.invocation.invocation : token.resource.label;
        const removeLabel = token.type === "invocation"
          ? `Remove ${token.invocation.kind} ${token.invocation.invocation}`
          : `Remove resource ${token.resource.label}`;
        return (
          <span
            key={key}
            data-slot="composer-reference-token"
            data-reference-kind={kind}
            data-testid={`composer-reference-token-${kind}-${id}`}
            className="inline-flex min-h-7 max-w-64 items-center gap-1.5 rounded-md border px-2 text-xs font-medium"
            style={{
              borderColor: "color-mix(in srgb, var(--accent) 32%, var(--border-default))",
              background: "color-mix(in srgb, var(--accent) 10%, var(--bg-surface))",
              color: "var(--text-primary)",
            }}
          >
            <span data-slot="composer-reference-token-icon" className="shrink-0" style={{ color: "var(--accent)" }}>
              {token.type === "invocation"
                ? token.invocation.kind === "skill" ? <Box size={13} aria-hidden /> : <SquareTerminal size={13} aria-hidden />
                : token.resource.kind === "file" ? <File size={13} aria-hidden /> : <FolderOpen size={13} aria-hidden />}
            </span>
            <span className="truncate">{label}</span>
            <button
              type="button"
              aria-label={removeLabel}
              className="-mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-[var(--bg-hover)]"
              onClick={() => onChange?.(
                tokens.filter((candidate) => composerReferenceTokenKey(candidate) !== key),
              )}
            >
              <X size={12} aria-hidden />
            </button>
          </span>
        );
      })}
      {attachments}
    </div>
  );
}

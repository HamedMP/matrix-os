import type { CanonicalChatResourceReference } from "@matrix-os/contracts";
import { Fragment } from "react";
import { Paperclip } from "@renderer/lib/hugeicons";
import { ComposerResourceGlyph } from "./ComposerResourceGlyph";

export function ResourceRows({
  role,
  canAttach,
  resources,
  selectedIndex,
  onAttach,
  onResource,
}: {
  role: "menuitem" | "option";
  canAttach: boolean;
  resources: CanonicalChatResourceReference[];
  selectedIndex?: number;
  onAttach: () => void;
  onResource: (resource: CanonicalChatResourceReference) => void;
}) {
  const offset = canAttach ? 1 : 0;
  return (
    <>
      {canAttach ? (
        <button
          type="button"
          role={role}
          {...(role === "option" ? { "aria-selected": selectedIndex === 0 } : {})}
          className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-[var(--bg-hover)] aria-selected:bg-[var(--bg-hover)]"
          style={{ color: "var(--text-primary)" }}
          onClick={onAttach}
        >
          <Paperclip size={15} aria-hidden style={{ color: "var(--text-secondary)" }} />
          <span>Attach files</span>
        </button>
      ) : null}
      {resources.map((resource, index) => (
        <Fragment key={`${resource.kind}:${resource.id}`}>
        {(resource.kind === "agent" || resource.kind === "chat") && resources[index - 1]?.kind !== resource.kind ? (
          <p className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--text-tertiary)" }}>
            {resource.kind === "agent" ? "Agents" : "Chats"}
          </p>
        ) : null}
        <button
          key={`${resource.kind}:${resource.id}`}
          type="button"
          role={role}
          {...(role === "option" ? { "aria-selected": selectedIndex === index + offset } : {})}
          className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-[var(--bg-hover)] aria-selected:bg-[var(--bg-hover)]"
          onClick={() => onResource(resource)}
        >
          <span className="inline-flex shrink-0" style={{ color: "var(--text-tertiary)" }}>
            <ComposerResourceGlyph resource={resource} size={15} />
          </span>
          <span className="truncate text-sm" style={{ color: "var(--text-primary)" }}>{resource.label}</span>
          <span className="ml-auto shrink-0 text-[11px] capitalize" style={{ color: "var(--text-tertiary)" }}>{resource.kind.replace("_", " ")}</span>
        </button>
        </Fragment>
      ))}
    </>
  );
}

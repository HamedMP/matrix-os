import { ProjectAgentConfigFileSchema } from "@matrix-os/contracts";
import { useLayoutEffect, useRef, useState } from "react";
import { useProjectAgentContext, type ProjectAgentContextRead } from "./project-agent-context.js";
import type { ProjectChatSkillCatalog } from "./canonical-slash-entries.js";

export interface ProjectChatSlashScope {
  scope: string;
  projectId: string;
  read: ProjectAgentContextRead | null;
}

export function useProjectChatSlashSkills(project: ProjectChatSlashScope | undefined, open: boolean): {
  catalog: ProjectChatSkillCatalog | undefined;
  loading: boolean;
} {
  const [opening, setOpening] = useState({ open, revision: 0 });
  if (open !== opening.open) setOpening({ open, revision: opening.revision + 1 });
  const { state } = useProjectAgentContext({
    scope: JSON.stringify([project?.scope, opening.revision]),
    projectId: project?.projectId ?? "",
    read: open ? project?.read ?? null : null,
  });
  if (!project) return { catalog: undefined, loading: false };
  return {
    catalog: state.kind === "ready"
      ? { skills: state.context.skills, available: true }
      : { skills: [], available: false },
    loading: state.kind === "loading",
  };
}

const EMPTY_PATHS: readonly string[] = [];
const MAX_PROJECT_SKILLS = 5;

export function useProjectSkillDraft(binding: string) {
  const [draft, setDraft] = useState({ binding, paths: EMPTY_PATHS });
  if (draft.binding !== binding) setDraft({ binding, paths: EMPTY_PATHS });
  const paths = draft.binding === binding ? draft.paths : EMPTY_PATHS;
  const current = useRef<typeof draft | null>(null);
  useLayoutEffect(() => {
    current.current = draft;
    return () => { current.current = null; };
  }, [draft]);
  const isCurrent = () => current.current === draft;
  return {
    paths,
    isCurrent,
    select(path: string): boolean {
      if (!isCurrent() || !path.endsWith("/SKILL.md") || !ProjectAgentConfigFileSchema.safeParse(path).success) return false;
      if (paths.includes(path)) return true;
      if (paths.length >= MAX_PROJECT_SKILLS) return false;
      setDraft(previous => previous.binding !== binding || previous.paths.length >= MAX_PROJECT_SKILLS || previous.paths.includes(path)
        ? previous : { binding, paths: [...previous.paths, path] });
      return true;
    },
    remove(path: string) {
      if (!isCurrent()) return;
      setDraft(previous => previous.binding !== binding ? previous : { binding, paths: previous.paths.filter(candidate => candidate !== path) });
    },
    clear() {
      // A send only consumes the selection it captured, not edits made while it was pending.
      setDraft(previous => previous.binding === binding && previous.paths === paths ? { binding, paths: EMPTY_PATHS } : previous);
    },
    prompt(text: string) {
      if (!isCurrent() || paths.length === 0) return text;
      return [text, ...paths.map(path => `Use the project skill defined in \`${path}\`. Read this file relative to the project root and follow its applicable instructions for this turn.`)].filter(Boolean).join("\n\n");
    },
  };
}

export function ProjectSkillDraftChips({ paths, onRemove }: { paths: readonly string[]; onRemove(path: string): void }) {
  if (!paths.length) return null;
  return <>
    <ul aria-label="Selected project skills" className="flex min-w-0 flex-wrap gap-1.5 px-2 pb-1">
      {paths.map(path => {
        const name = path.split("/")[2];
        return <li key={path} className="flex min-w-0 items-center rounded-md border border-border bg-muted px-2 text-xs" title={path}>
          <span className="truncate">{name}</span>
          <button type="button" aria-label={`Remove skill ${name}`} className="ml-1 px-1 py-0.5" onClick={() => onRemove(path)}>×</button>
        </li>;
      })}
    </ul>
    {paths.length === MAX_PROJECT_SKILLS ? <p role="status" className="px-2 pb-1 text-xs text-muted-foreground">
      Remove a project skill to add another.
    </p> : null}
  </>;
}

import { Plus } from "lucide-react";
import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  PROJECT_AGENT_CONFIG_CREATE_ERROR,
  PROJECT_SKILL_FILE_MAX_BYTES,
  type ProjectAgentConfigurationTemplate,
  type ProjectInstalledSkill,
} from "./project-agent-context.js";
import {
  copyProjectSkill,
  importProjectSkill,
  newProjectSkill,
  PROJECT_SKILL_COPY_ERROR,
  PROJECT_SKILL_DESCRIPTION_LIMIT,
  PROJECT_SKILL_IMPORT_ERROR,
  type ProjectSkillDraft,
} from "./project-skill-file.js";

type Action = "installed" | "new" | "import";
export type NewSkillDraft = { name: string; description: string; instructions: string };
type BuildDraft = (signal: AbortSignal) => ProjectSkillDraft | Promise<ProjectSkillDraft>;
type SkillList = { kind: "loading" | "error" } | { kind: "ready"; skills: readonly ProjectInstalledSkill[] };

export interface ProjectSkillSourceActions {
  loadInstalledSkills?: (signal: AbortSignal) => Promise<readonly ProjectInstalledSkill[]>;
  readInstalledSkill?: (file: string, signal: AbortSignal) => Promise<string>;
}

const inputClass = "block min-h-8 w-full rounded-md border bg-transparent px-2.5 py-1 outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
const buttonClass = "min-h-8 max-w-full rounded-md border px-2.5 py-1 text-left text-xs font-medium hover:bg-[var(--bg-hover,var(--accent))] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50";
const borderStyle = { borderColor: "var(--border-subtle, var(--border))" };
const secondaryStyle = { color: "var(--text-secondary, var(--muted-foreground))" };

interface Props extends ProjectSkillSourceActions {
  filesPending: boolean;
  onCreate: (draft: ProjectAgentConfigurationTemplate) => Promise<boolean>;
  newSkillDraft: NewSkillDraft | null;
  onNewSkillDraftChange: (draft: NewSkillDraft | null) => void;
}

export function ProjectSkillActions({ filesPending, onCreate, loadInstalledSkills, readInstalledSkill, newSkillDraft, onNewSkillDraftChange }: Props) {
  const id = useId();
  const [open, setOpen] = useState(newSkillDraft !== null);
  const [source, setSource] = useState<"installed" | "import" | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => () => active.current?.abort(), []);

  const busy = filesPending || pending;
  const action = newSkillDraft ? "new" : source;
  const choose = (next: Action | null) => {
    setSource(next === "new" ? null : next);
    onNewSkillDraftChange(next === "new" ? { name: "", description: "", instructions: "" } : null);
    setError(null);
  };

  const submit = async (buildDraft: BuildDraft, readError: string) => {
    if (busy || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setError(null);
    try {
      const draft = await buildDraft(controller.signal);
      if (controller.signal.aborted) return;
      if ("error" in draft) {
        setError(draft.error);
        return;
      }
      const created = await onCreate(draft);
      if (controller.signal.aborted) return;
      if (!created) {
        setError(PROJECT_AGENT_CONFIG_CREATE_ERROR);
        return;
      }
      setOpen(false);
      choose(null);
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        console.warn("[project-context] Could not prepare project skill:", error instanceof Error ? error.name : "UnknownError");
        setError(readError);
      }
    } finally {
      active.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  };

  const actions = <button type="button" className={buttonClass} style={borderStyle} disabled={busy} onClick={() => { choose(null); addButton.current?.focus(); }}>Cancel</button>;
  const canCopy = loadInstalledSkills && readInstalledSkill;

  return (
    <div className="min-w-0 space-y-2">
      <button ref={addButton} type="button" className={buttonClass} style={borderStyle} disabled={busy} aria-controls={id} aria-expanded={open}
        onClick={() => { setOpen(!open); choose(null); }}>
        <span className="flex items-center gap-1.5"><Plus size={13} aria-hidden className="shrink-0" />Add skill</span>
      </button>
      <div id={id} hidden={!open} aria-busy={busy}>
        {open && action === null ? <div className="flex min-w-0 flex-wrap gap-2">
          {canCopy ? <button type="button" className={buttonClass} style={borderStyle} disabled={busy}
            onClick={() => choose("installed")}>Choose installed skill</button> : null}
          <button type="button" className={buttonClass} style={borderStyle} disabled={busy}
            onClick={() => choose("new")}>New skill</button>
          <button type="button" className={buttonClass} style={borderStyle} disabled={busy}
            onClick={() => choose("import")}>Import SKILL.md</button>
        </div> : null}
        {open && action === "installed" && canCopy ? <InstalledSkillForm busy={busy} load={loadInstalledSkills}
          onSubmit={skill => { void submit(async signal => copyProjectSkill(await readInstalledSkill(skill.file, signal), skill.name), PROJECT_SKILL_COPY_ERROR); }}>
          {actions}
        </InstalledSkillForm> : null}
        {open && newSkillDraft ? <NewSkillForm busy={busy} draft={newSkillDraft} onChange={onNewSkillDraftChange}
          onSubmit={(name, description, instructions) => { void submit(() => newProjectSkill(name, description, instructions), PROJECT_AGENT_CONFIG_CREATE_ERROR); }}>
          {actions}
        </NewSkillForm> : null}
        {open && action === "import" ? <ImportSkillForm busy={busy}
          onSubmit={file => { void submit(() => importProjectSkill(file), PROJECT_SKILL_IMPORT_ERROR); }}>
          {actions}
        </ImportSkillForm> : null}
        {error ? <p role="alert" className="mt-2 text-xs">{error}</p> : null}
      </div>
    </div>
  );
}

function InstalledSkillForm({ busy, load, onSubmit, children }: {
  busy: boolean;
  load: NonNullable<ProjectSkillSourceActions["loadInstalledSkills"]>;
  onSubmit: (skill: ProjectInstalledSkill) => void;
  children: ReactNode;
}) {
  const radioName = useId();
  const [list, setList] = useState<SkillList>({ kind: "loading" });
  const [query, setQuery] = useState("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const request = useEffectEvent(load);

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- load the catalog only when the user opens this picker and cancel it on close.
  useEffect(() => {
    const controller = new AbortController();
    void request(controller.signal).then(skills => {
      if (!controller.signal.aborted) setList({ kind: "ready", skills });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      console.warn("[project-context] Installed skills unavailable:", error instanceof Error ? error.name : "UnknownError");
      setList({ kind: "error" });
    });
    return () => controller.abort();
  }, [revision]);

  const term = query.trim().toLowerCase();
  const matching = list.kind === "ready" ? list.skills.filter(skill =>
    skill.name.toLowerCase().includes(term) || skill.description?.toLowerCase().includes(term)) : [];
  const selected = matching.find(skill => skill.file === selectedFile);

  return (
    <form className="space-y-2" onSubmit={event => { event.preventDefault(); if (!busy && selected) onSubmit(selected); }}>
      <p className="text-xs leading-relaxed" style={secondaryStyle}>Only the SKILL.md file is copied. Add any required scripts or other files separately.</p>
      <label className="block space-y-1 text-xs">
        <span>Search installed skills</span>
        <input type="search" autoFocus className={inputClass} style={borderStyle} value={query} maxLength={128}
          disabled={busy} onChange={event => { setQuery(event.target.value); setSelectedFile(null); }} />
      </label>
      {list.kind === "loading" ? <p role="status" className="text-xs" style={secondaryStyle}>Loading installed skills…</p> : null}
      {list.kind === "error" ? <>
        <p role="alert" className="text-xs">Installed skills could not be loaded.</p>
        <button type="button" className={buttonClass} style={borderStyle} disabled={busy}
          onClick={() => { setList({ kind: "loading" }); setRevision(value => value + 1); }}>Retry loading skills</button>
      </> : null}
      {list.kind === "ready" && list.skills.length === 0 ? <p className="text-xs" style={secondaryStyle}>No installed skills on this computer.</p> : null}
      {list.kind === "ready" && list.skills.length > 0 ? <>
        {matching.length > 0 ? <fieldset className="max-h-44 min-w-0 overflow-y-auto rounded-md border" style={borderStyle}>
          <legend className="sr-only">Installed skills</legend>
          {matching.map(skill => <label key={skill.file} className="flex min-w-0 cursor-pointer items-start gap-2 px-2.5 py-1.5 text-xs hover:bg-[var(--bg-hover,var(--accent))]">
            <input type="radio" name={radioName} className="mt-0.5 shrink-0" disabled={busy}
              checked={selectedFile === skill.file} onChange={() => setSelectedFile(skill.file)} />
            <span className="min-w-0 [overflow-wrap:anywhere]">
              <span className="block font-medium">{skill.name}</span>
              {skill.description ? <span className="block" style={secondaryStyle}>{skill.description}</span> : null}
            </span>
          </label>)}
        </fieldset> : <p role="status" className="text-xs" style={secondaryStyle}>No installed skills match your search.</p>}
      </> : null}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={buttonClass} style={borderStyle} disabled={busy || !selected}>Copy to project</button>
        {children}
      </div>
    </form>
  );
}

function NewSkillForm({ busy, draft, onChange, onSubmit, children }: {
  busy: boolean;
  draft: NewSkillDraft;
  onChange: (draft: NewSkillDraft) => void;
  onSubmit: (name: string, description: string, instructions: string) => void;
  children: ReactNode;
}) {
  const { name, description, instructions } = draft;

  return (
    <form className="space-y-2" onSubmit={event => { event.preventDefault(); if (!busy) onSubmit(name, description, instructions); }}>
      <label className="block space-y-1 text-xs">
        <span>Skill name</span>
        <input type="text" autoFocus value={name} maxLength={64} placeholder="release-review" className={inputClass} style={borderStyle}
          disabled={busy} onChange={event => onChange({ ...draft, name: event.target.value })} />
      </label>
      <label className="block space-y-1 text-xs">
        <span>Description</span>
        <input type="text" value={description} maxLength={PROJECT_SKILL_DESCRIPTION_LIMIT} placeholder="When should the agent use this skill?"
          className={inputClass} style={borderStyle} disabled={busy} onChange={event => onChange({ ...draft, description: event.target.value })} />
      </label>
      <label className="block space-y-1 text-xs">
        <span>Instructions</span>
        <textarea value={instructions} rows={4} maxLength={PROJECT_SKILL_FILE_MAX_BYTES} placeholder="What should the agent do?"
          className={`${inputClass} resize-y`} style={borderStyle} disabled={busy} onChange={event => onChange({ ...draft, instructions: event.target.value })} />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={buttonClass} style={borderStyle} disabled={busy}>Create skill</button>
        {children}
      </div>
    </form>
  );
}

function ImportSkillForm({ busy, onSubmit, children }: {
  busy: boolean;
  onSubmit: (file: File) => void;
  children: ReactNode;
}) {
  const [file, setFile] = useState<File | null>(null);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!busy && file) onSubmit(file);
  };

  return (
    <form className="space-y-2" onSubmit={submit}>
      <label className="block space-y-1 text-xs">
        <span>SKILL.md file</span>
        <span className="flex min-h-8 items-center rounded-md border px-2.5 focus-within:ring-2 focus-within:ring-[var(--accent)]" style={borderStyle}>
          <input type="file" autoFocus accept=".md,text/markdown" className="block w-full min-w-0 leading-normal outline-none" disabled={busy}
            onChange={event => setFile(event.target.files?.[0] ?? null)} />
        </span>
      </label>
      <p className="text-xs leading-relaxed" style={secondaryStyle}>Choose a Markdown file with a skill name, description, and instructions.</p>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={buttonClass} style={borderStyle} disabled={busy || !file}>Import skill</button>
        {children}
      </div>
    </form>
  );
}

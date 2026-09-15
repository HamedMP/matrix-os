import { useId, useMemo, useState } from "react";
import { CHAT_AGENT_RECIPE_MAX_INSTRUCTION_BYTES, CHAT_AGENT_RECIPE_MAX_SKILLS, type ChatAgentRecipeCatalog } from "@matrix-os/contracts";
import { chatAgentButtonClass, chatAgentInputClass, chatAgentMutedStyle } from "./theme.js";
import { recipeSkillInstructionBytes } from "./recipe-skills.js";

const PAGE_SIZE = 12;

export function AgentRecipeSkills({ skills, selected, pending, loading, unavailable, onChange, onRefresh }: {
  skills: ChatAgentRecipeCatalog["skills"]; selected: string[];
  pending: boolean; loading: boolean; unavailable: boolean;
  onChange(skills: string[]): void; onRefresh(): void;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const filtered = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return skills.filter((skill) => !search || `${skill.name}\n${skill.description}`.toLocaleLowerCase().includes(search));
  }, [skills, query]);
  // Snapshot-local membership, bounded by the eight-skill recipe limit.
  const selectedIds = useMemo(() => new Set(selected), [selected]);
  const missing = selected.filter((skillId) => !skills.some((skill) => skill.id === skillId));
  const atLimit = selected.length >= CHAT_AGENT_RECIPE_MAX_SKILLS;
  const selectedBytes = recipeSkillInstructionBytes(selected, skills);
  const tooLarge = (skill: ChatAgentRecipeCatalog["skills"][number]) =>
    !selectedIds.has(skill.id) && selectedBytes + (skill.instructionBytes ?? 0) > CHAT_AGENT_RECIPE_MAX_INSTRUCTION_BYTES;
  const search = (value: string) => { setQuery(value); setVisibleCount(PAGE_SIZE); };

  return <fieldset className="grid min-w-0 gap-3">
    <legend className="text-sm font-medium">Skills</legend>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs" style={chatAgentMutedStyle}>{selected.length} of {CHAT_AGENT_RECIPE_MAX_SKILLS} selected · {skills.length} available</p>
      <button type="button" className={chatAgentButtonClass} disabled={pending || loading} onClick={onRefresh}>Refresh skills</button>
    </div>
    <div className="flex min-w-0 items-center gap-2">
      <label className="min-w-0 flex-1" htmlFor={id}>
        <span className="sr-only">Search skills</span>
        <input id={id} type="search" className={chatAgentInputClass} value={query} maxLength={200}
          placeholder="Search skills by name or description" disabled={pending}
          onChange={(event) => search(event.target.value)} />
      </label>
      {query ? <button type="button" className={chatAgentButtonClass} disabled={pending}
        aria-label="Clear skill search" onClick={() => search("")}>Clear</button> : null}
    </div>
    {atLimit ? <p className="text-xs" style={chatAgentMutedStyle}>Remove a selected skill to choose another.</p> : null}
    {selectedBytes > CHAT_AGENT_RECIPE_MAX_INSTRUCTION_BYTES ? <p role="alert" className="text-xs">
      These skills are too large to use together. Remove a selected skill.
    </p> : null}
    {missing.map((skillId) => <label key={skillId} className="flex min-w-0 items-center gap-2 text-sm">
      <input type="checkbox" checked disabled={pending} aria-label={`${skillId} · unavailable`}
        onChange={() => onChange(selected.filter((value) => value !== skillId))} />
      <span className="min-w-0 truncate" title={skillId}>{skillId} · unavailable</span>
    </label>)}
    {filtered.slice(0, visibleCount).map((skill) => <label key={skill.id} className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 text-sm">
      <input type="checkbox" aria-label={skill.name} className="mt-0.5" checked={selectedIds.has(skill.id)}
        disabled={pending || (atLimit && !selectedIds.has(skill.id)) || tooLarge(skill)}
        onChange={(event) => onChange(event.target.checked ? [...selected, skill.id] : selected.filter((value) => value !== skill.id))} />
      <span className="min-w-0 truncate" title={skill.name}>{skill.name}</span>
      <span className="col-start-2 break-words text-xs" style={chatAgentMutedStyle}>{skill.description}</span>
      {tooLarge(skill) ? <span className="col-start-2 text-xs" style={chatAgentMutedStyle}>Too large to combine with the selected skills.</span> : null}
    </label>)}
    {!loading && !unavailable && !filtered.length ? <p className="text-xs" style={chatAgentMutedStyle}>
      {query.trim() ? "No skills match your search." : "No usable skills are installed on this computer."}
    </p> : null}
    {filtered.length > visibleCount ? <button type="button" className={`${chatAgentButtonClass} justify-self-start`}
      disabled={pending} onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>Show more skills</button> : null}
  </fieldset>;
}

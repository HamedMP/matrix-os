"use client";
import { organizationColor, organizationInitial } from "./organization-identity";
import type { LauncherChip, LauncherFilter } from "./launcher-filter";

export function LauncherFilterChips({ chips, value, onChange, className }: {
  chips: readonly LauncherChip[]; value: LauncherFilter; onChange: (filter: LauncherFilter) => void; className?: string;
}) {
  return <div role="group" aria-label="Filter apps" className={`flex flex-wrap justify-center gap-2 ${className ?? ""}`}>
    {chips.map((chip) => {
      const on = chip.filter === value;
      return <button key={chip.filter} type="button" aria-pressed={on} onClick={() => onChange(chip.filter)}
        className={`flex h-8 items-center gap-1.5 rounded-full border text-[13px] font-medium transition-colors ${chip.organization ? "pl-1.5 pr-3" : "px-3"} ${on ? "border-[#18181B] bg-[#18181B] text-white" : "border-[#E4E0D6] bg-white text-[#18181B] hover:bg-[#F4F4F5]"}`}>
        {chip.organization ? <span aria-hidden="true" style={{ background: organizationColor(chip.organization.organizationId), boxShadow: on ? "0 0 0 1.5px #FFFFFF" : undefined }}
          className="flex size-5 items-center justify-center rounded-full text-[10px] font-bold text-white">{organizationInitial(chip.organization.name)}</span> : null}
        <span>{chip.label}</span>
        {chip.count !== undefined ? <span className={`text-xs ${on ? "text-[#D4D4D8]" : "text-[#57534E]"}`}>{chip.count}</span> : null}
      </button>;
    })}
  </div>;
}

/** Blue dot before the name of a newly shared app, until first opened. */
export function NewAppDot() {
  return <><span aria-hidden="true" className="mr-1 inline-block size-1.5 shrink-0 rounded-full bg-[#2563EB] align-middle" /><span className="sr-only">New: </span></>;
}

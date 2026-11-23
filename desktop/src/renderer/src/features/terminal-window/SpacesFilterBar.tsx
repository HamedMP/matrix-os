// The top of Spaces (ENG-521): a field to narrow spaces by name and a toggle
// per kind of machine, in the Herdr look of the rest of the sidebar.
import { Input } from "@matrix-os/ui";
import { Button } from "../../design/primitives";
import { SPACE_GROUPS, SPACE_GROUP_LABEL, SPACES_QUERY_MAX, type SpaceGroup } from "./spaces-filter";

export function SpacesFilterBar({ query, onQuery, hidden, onToggle, groups, thisName }: {
  query: string;
  onQuery(query: string): void;
  hidden: readonly SpaceGroup[];
  onToggle(group: SpaceGroup): void;
  /** The kinds present now; a toggle shows only for those. */
  groups: ReadonlySet<SpaceGroup>;
  /** This device's own name ("This Mac"), for its toggle. */
  thisName?: string;
}) {
  const off = new Set(hidden);
  return (
    <div className="flex flex-col gap-1 px-2 pb-1">
      <Input aria-label="Filter spaces" placeholder="Filter spaces" value={query} maxLength={SPACES_QUERY_MAX}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape" && query) { event.stopPropagation(); onQuery(""); } }}
        style={{ padding: "2px 6px", fontSize: 12 }} />
      <div role="group" aria-label="Kinds of spaces" className="flex flex-wrap gap-1">
        {SPACE_GROUPS.filter((group) => groups.has(group)).map((group) => {
          const shown = !off.has(group);
          return (
            <Button key={group} variant="ghost" aria-pressed={shown} onClick={() => onToggle(group)}
              className="outline-none focus-visible:ring-2 focus-visible:ring-current"
              style={{
                height: 20, padding: "0 6px", fontSize: 11, borderRadius: 999,
                border: "1px solid var(--border-subtle)",
                background: shown ? "var(--bg-hover)" : undefined,
                color: shown ? "var(--text-primary)" : "var(--text-tertiary, var(--text-secondary))",
              }}>
              {group === "this" && thisName ? thisName : SPACE_GROUP_LABEL[group]}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

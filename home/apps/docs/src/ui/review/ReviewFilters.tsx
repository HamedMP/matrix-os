import { Select } from "../../../../_shared/office-ui";
import { type CategoryFilter, KIND_FILTERS, type ReviewController, type ReviewSnapshot } from "../../review/index";

const ALL = "";

const CATEGORIES: ReadonlyArray<{ value: CategoryFilter; label: string }> = [
  { value: "all", label: "All changes" },
  { value: "substantive", label: "Substantive" },
  { value: "formatting", label: "Formatting only" },
];

function kindChoice(kinds: readonly string[]): string {
  if (kinds.length === 0) return ALL;
  const chosen = new Set(kinds);
  const match = KIND_FILTERS.find((choice) => choice.kinds.length === chosen.size && choice.kinds.every((kind) => chosen.has(kind)));
  return match?.id ?? ALL;
}

export interface ReviewFiltersProps {
  controller: ReviewController;
  snapshot: ReviewSnapshot;
}

/** Author, kind and category filters of the revision list. */
export function ReviewFilters({ controller, snapshot }: ReviewFiltersProps) {
  const { filter, authors } = snapshot;
  const author = filter.authors.length === 1 ? filter.authors[0]! : ALL;
  return (
    <div className="docs-review__filters" role="group" aria-label="Filter changes">
      <Select
        label="Author"
        value={author}
        onChange={(value) => controller.setFilter({ authors: value === ALL ? [] : [value] })}
        options={[{ value: ALL, label: "All authors" }, ...authors.map((name) => ({ value: name, label: name }))]}
      />
      <Select
        label="Kind"
        value={kindChoice(filter.kinds)}
        onChange={(value) => controller.setFilter({ kinds: KIND_FILTERS.find((choice) => choice.id === value)?.kinds ?? [] })}
        options={[{ value: ALL, label: "All kinds" }, ...KIND_FILTERS.map((choice) => ({ value: choice.id, label: choice.label }))]}
      />
      <div className="docs-review__segments" role="radiogroup" aria-label="Show">
        {CATEGORIES.map((category) => (
          <button
            key={category.value}
            type="button"
            role="radio"
            aria-checked={filter.category === category.value}
            className={filter.category === category.value ? "docs-review__segment is-selected" : "docs-review__segment"}
            onClick={() => controller.setFilter({ category: category.value })}
          >
            {category.label}
          </button>
        ))}
      </div>
      {snapshot.filtered && (
        <button type="button" className="oui-button oui-button--ghost docs-review__clear" onClick={() => controller.clearFilter()}>
          Clear filters
        </button>
      )}
    </div>
  );
}

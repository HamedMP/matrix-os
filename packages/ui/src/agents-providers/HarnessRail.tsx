import type { ProviderHarnessInstance } from "@matrix-os/contracts";
import { authLabel, titleCase } from "./utils.js";

function railStatus(harness: ProviderHarnessInstance): string {
  if (harness.installState !== "installed") return titleCase(harness.installState);
  if (harness.connectivity === "offline") return "Offline";
  if (!harness.enabled) return "Disabled";
  return authLabel(harness.authState);
}

export function HarnessRail({
  harnesses,
  selectedId,
  disabled,
  canAdd,
  onSelect,
  onAdd,
}: {
  harnesses: ProviderHarnessInstance[];
  selectedId: string | null;
  disabled: boolean;
  canAdd: boolean;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  return (
    <nav className="matrix-ap-rail" aria-label="Agent harnesses">
      <div className="matrix-ap-rail-head">
        <span>Harnesses</span>
        <button
          type="button"
          className="matrix-ap-add-button"
          aria-label="Add harness"
          onClick={onAdd}
          disabled={disabled || !canAdd}
          title={canAdd ? "Add harness" : "Adding harnesses is not available"}
        >
          <span aria-hidden="true">+</span>
        </button>
      </div>
      <div className="matrix-ap-rail-list">
        {harnesses.map((harness) => {
          const selected = harness.id === selectedId;
          const status = railStatus(harness);
          return (
            <button
              key={harness.id}
              type="button"
              className="matrix-ap-rail-item"
              data-selected={selected ? "true" : undefined}
              aria-current={selected ? "true" : undefined}
              onClick={() => onSelect(harness.id)}
            >
              <span
                className="matrix-ap-harness-mark"
                data-accent={harness.accentColor ?? "none"}
                aria-hidden="true"
              >
                {harness.displayName.slice(0, 1).toUpperCase()}
              </span>
              <span className="matrix-ap-rail-copy">
                <span className="matrix-ap-rail-name">
                  {harness.displayName}
                  {harness.version ? <span>{harness.version}</span> : null}
                </span>
                <span className="matrix-ap-rail-status" data-state={status.toLowerCase().replaceAll(" ", "-")}>
                  <i aria-hidden="true" />{status}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

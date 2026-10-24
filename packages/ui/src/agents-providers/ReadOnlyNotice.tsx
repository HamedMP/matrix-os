import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { titleCase } from "./utils.js";

type ReadOnlyAccess = Extract<ProviderSettingsSnapshot["access"], { mode: "read_only" }>;

/** Why this computer's agents and providers cannot be changed, shown above controls that are disabled. */
export function ReadOnlyNotice({ access }: { access: ReadOnlyAccess }) {
  return (
    <div className="matrix-ap-notice" data-tone="neutral" role="status">
      <strong>Read only</strong>
      <span>{access.reason === "remote_policy" ? "Your organization controls these settings." : `Changes are unavailable: ${titleCase(access.reason).toLowerCase()}.`}</span>
    </div>
  );
}

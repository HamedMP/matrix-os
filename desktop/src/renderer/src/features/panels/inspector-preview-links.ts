import type { PreviewLink } from "@matrix-os/ui";
import type { InspectorFileTarget } from "./InspectorFilesPanel";

export function targetForPreviewLink(
  current: InspectorFileTarget,
  link: Extract<PreviewLink, { kind: "file" }>,
): InspectorFileTarget {
  const label = link.path.split("/").at(-1) ?? link.path;
  return link.scope === "home"
    ? { kind: "home", path: link.path, label }
    : { ...current, path: link.path, label };
}

import FilesWorkspace from "./FilesWorkspace";
import FilesWorkspaceV2 from "./redesign/FilesWorkspaceV2";
import { useFilesRedesignFlag } from "./redesign/use-files-redesign-flag";

/** Chooses the Files layout from the `desktop-files-redesign` flag; renders nothing while the flag loads. */
export default function FilesSurface() {
  const redesign = useFilesRedesignFlag();
  if (redesign === null) return <div className="flex-1" aria-busy="true" />;
  return redesign ? <FilesWorkspaceV2 /> : <FilesWorkspace />;
}

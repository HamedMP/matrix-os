import { useLocalSearchParams } from "expo-router";

import { FolderWorkspace } from "@/components/mock-shell/FolderWorkspace";

export default function FileBrowserScreen() {
  const params = useLocalSearchParams<{ folder?: string | string[] }>();
  const folder = Array.isArray(params.folder) ? params.folder[0] : params.folder;
  return <FolderWorkspace segments={[folder || "Projects"]} />;
}

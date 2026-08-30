import { useLocalSearchParams } from "expo-router";

import { FolderWorkspace } from "@/components/mock-shell/FolderWorkspace";

export default function NestedFolderScreen() {
  const params = useLocalSearchParams<{ path?: string | string[] }>();
  const segments = Array.isArray(params.path)
    ? params.path
    : (params.path ?? "Projects").split("/").filter(Boolean);
  return <FolderWorkspace segments={segments} />;
}

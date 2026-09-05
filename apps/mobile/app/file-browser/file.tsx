import { Stack, useLocalSearchParams } from "expo-router";

import { ComputerFilePreview } from "@/components/files/ComputerFilePreview";

export default function FileDetailScreen() {
  const params = useLocalSearchParams<{ name?: string | string[]; path?: string | string[] }>();
  const rawName = Array.isArray(params.name) ? params.name[0] : params.name;
  const rawPath = Array.isArray(params.path) ? params.path[0] : params.path;
  const name = rawName || rawPath?.split("/").filter(Boolean).at(-1) || "File";

  return (
    <>
      <Stack.Screen options={{ title: name }} />
      <ComputerFilePreview name={name} path={rawPath ?? ""} />
    </>
  );
}

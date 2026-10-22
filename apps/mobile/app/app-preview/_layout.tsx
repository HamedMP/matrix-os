import { Stack, useRouter } from "expo-router";
import { useUnistyles } from "react-native-unistyles";

import { AppPreviewHeader } from "@/components/apps/AppPreviewHeader";

export default function AppPreviewLayout() {
  const router = useRouter();
  const { theme } = useUnistyles();

  return (
    <Stack screenOptions={{
      header: ({ options }: { options: { title?: string } }) => (
        <AppPreviewHeader title={options.title ?? ""} onClose={() => router.dismiss()} />
      ),
      contentStyle: { backgroundColor: theme.v2.appColors.canvas },
    }} />
  );
}

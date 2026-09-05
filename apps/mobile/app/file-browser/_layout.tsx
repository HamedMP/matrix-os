import ArrowLeft01Icon from "@hugeicons/core-free-icons/ArrowLeft01Icon";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import { Stack, useGlobalSearchParams, usePathname, useRouter } from "expo-router";
import { View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { FileCreationControls } from "@/components/files/FileCreationControls";
import { IconButton } from "@/components/ui";

export default function FileBrowserLayout() {
  const router = useRouter();
  const pathname = usePathname();
  const { theme } = useUnistyles();
  const params = useGlobalSearchParams<{
    folder?: string | string[];
    path?: string | string[];
  }>();
  const currentPath = resolveFileCreationPath(pathname, params);
  const closeButton = () => (
    <IconButton
      accessibilityLabel="Close file browser"
      icon={Cancel01Icon}
      iconSize={22}
      iconColor={theme.v2.appColors.ink}
      iconTestID="file-browser-close-icon"
      buttonSize={32}
      pressedOpacity={1}
      onPress={() => router.dismiss()}
    />
  );
  const backButton = () => (
    <IconButton
      accessibilityLabel="Back to previous folder"
      icon={ArrowLeft01Icon}
      iconSize={22}
      iconColor={theme.v2.appColors.ink}
      iconTestID="file-browser-back-icon"
      buttonSize={32}
      pressedOpacity={1}
      onPress={() => router.back()}
    />
  );

  return (
    <View style={styles.container}>
      <Stack
        screenOptions={{
          headerShadowVisible: false,
          headerStyle: { backgroundColor: theme.v2.appColors.canvas },
          headerTintColor: theme.v2.appColors.ink,
          headerTitleStyle: { fontFamily: theme.v2.fonts.semibold, fontSize: 15 },
          headerBackButtonDisplayMode: "minimal",
          contentStyle: { backgroundColor: theme.v2.appColors.canvas },
        }}
      >
        <Stack.Screen
          name="index"
          options={{
            title: "Files",
            headerBackVisible: false,
            headerLeft: closeButton,
            unstable_headerLeftItems: () => [{
              type: "custom",
              element: closeButton(),
              hidesSharedBackground: true,
            }],
          }}
        />
        <Stack.Screen
          name="[...path]"
          options={{
            headerBackVisible: false,
            headerLeft: backButton,
            unstable_headerLeftItems: () => [{
              type: "custom",
              element: backButton(),
              hidesSharedBackground: true,
            }],
          }}
        />
        <Stack.Screen
          name="file"
          options={{
            headerBackVisible: false,
            headerLeft: backButton,
            unstable_headerLeftItems: () => [{
              type: "custom",
              element: backButton(),
              hidesSharedBackground: true,
            }],
          }}
        />
      </Stack>
      <FileCreationControls currentPath={currentPath} />
    </View>
  );
}

export function resolveFileCreationPath(
  pathname: string,
  params: { folder?: string | string[]; path?: string | string[] },
) {
  const routePath = Array.isArray(params.path) ? params.path.join("/") : params.path;
  if (pathname.endsWith("/file")) {
    const segments = (routePath ?? "").split("/").filter(Boolean);
    return segments.slice(0, -1).join("/");
  }
  if (routePath) return routePath;
  return Array.isArray(params.folder) ? (params.folder[0] ?? "Projects") : (params.folder ?? "Projects");
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});

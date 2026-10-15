import { useState } from "react";
import AppWindowIcon from "@hugeicons/core-free-icons/AppWindowIcon";
import { Image } from "expo-image";
import { View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { Icon } from "@/components/ui";

import { APP_ARTWORK_FOOTPRINT, APP_ICON_SQUIRCLE } from "./app-icon-shape";

export function AppLogo({
  name,
  uri,
  authorization,
}: {
  name: string;
  uri: string | null;
  authorization?: string;
}) {
  // The address that failed, so a new address gets its own try.
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const { theme } = useUnistyles();
  const imageUri = uri && uri !== failedUri ? uri : null;

  return (
    <View testID={`app-logo-${name}`} style={styles.container}>
      <View testID={`app-icon-${name}`} style={[styles.artwork, !imageUri && styles.placeholder]}>
        {imageUri ? (
          <Image
            source={{
              uri: imageUri,
              headers: authorization ? { Authorization: authorization } : undefined,
            }}
            contentFit="contain"
            onError={() => setFailedUri(imageUri)}
            style={styles.image}
          />
        ) : (
          <Icon icon={AppWindowIcon} size={24} color={theme.v2.appColors.ink} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    width: APP_ARTWORK_FOOTPRINT,
    height: APP_ARTWORK_FOOTPRINT,
    alignItems: "center",
    justifyContent: "center",
  },
  // Icons made on the computer are often square images with no corners of
  // their own, so the squircle is cut here rather than left to the image.
  artwork: {
    ...APP_ICON_SQUIRCLE,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  placeholder: {
    backgroundColor: theme.v2.appColors.surface,
  },
  image: {
    width: APP_ICON_SQUIRCLE.width,
    height: APP_ICON_SQUIRCLE.height,
  },
}));

import { useEffect, useState } from "react";
import AppWindowIcon from "@hugeicons/core-free-icons/AppWindowIcon";
import { Image } from "expo-image";
import { View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { Icon } from "@/components/ui";

export function AppLogo({
  name,
  uri,
  authorization,
}: {
  name: string;
  uri: string | null;
  authorization?: string;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const { theme } = useUnistyles();

  useEffect(() => {
    setImageFailed(false);
  }, [uri]);

  return (
    <View testID={`app-logo-${name}`} style={styles.container}>
      {uri && !imageFailed ? (
        <Image
          source={{
            uri,
            headers: authorization ? { Authorization: authorization } : undefined,
          }}
          contentFit="contain"
          onError={() => setImageFailed(true)}
          style={styles.image}
        />
      ) : (
        <Icon icon={AppWindowIcon} size={24} color={theme.v2.appColors.ink} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: 68,
    height: 68,
    alignItems: "center",
    justifyContent: "center",
  },
  image: {
    width: 64,
    height: 64,
  },
});

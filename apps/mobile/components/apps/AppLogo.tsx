import { useEffect, useState } from "react";
import AppWindowIcon from "@hugeicons/core-free-icons/AppWindowIcon";
import { Image } from "expo-image";
import { StyleSheet, View } from "react-native";

import { Icon } from "@/components/ui";
import { mockColors } from "@/components/mock-shell/theme";

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
        <Icon icon={AppWindowIcon} size={24} color={mockColors.ink} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
  },
  image: {
    width: 38,
    height: 38,
  },
});

import { useEffect, useState } from "react";
import { Image } from "expo-image";
import { Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import type { IntegrationService } from "@/lib/requests";

export function IntegrationLogo({
  service,
  compact = false,
}: {
  service: Pick<IntegrationService, "id" | "name" | "category" | "logoUrl">;
  compact?: boolean;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const { theme } = useUnistyles();
  const size = compact ? 32 : 42;
  const imageSize = compact ? 24 : 32;

  useEffect(() => {
    setImageFailed(false);
  }, [service.logoUrl]);

  return (
    <View
      testID={`integration-logo-${service.id}`}
      style={[
        styles.container,
        {
          width: size,
          height: size,
          borderRadius: compact ? 10 : 12,
          backgroundColor: categoryColor(service.category),
        },
      ]}
    >
      {service.logoUrl && !imageFailed ? (
        <Image
          source={{ uri: service.logoUrl }}
          contentFit="contain"
          onError={() => setImageFailed(true)}
          style={{ width: imageSize, height: imageSize }}
        />
      ) : (
        <Text style={[styles.fallback, compact && styles.fallbackCompact]}>
          {service.name.charAt(0).toUpperCase()}
        </Text>
      )}
    </View>
  );

  function categoryColor(category: string): string {
    if (category === "google") return theme.v2.palette.blue[50];
    if (category === "communication") return theme.v2.palette.green[100];
    return theme.v2.palette.neutral[100];
  }
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  fallback: {
    fontFamily: theme.v2.fonts.semibold,
    fontSize: 16,
    color: theme.v2.palette.neutral[700],
  },
  fallbackCompact: {
    fontSize: 13,
  },
}));

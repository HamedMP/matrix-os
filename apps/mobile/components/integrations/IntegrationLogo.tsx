import { useEffect, useState } from "react";
import { Image } from "expo-image";
import { StyleSheet, Text, View } from "react-native";

import { mockFonts } from "@/components/mock-shell/theme";
import type { IntegrationService } from "@/lib/requests";
import { palette } from "@/lib/theme";

export function IntegrationLogo({
  service,
  compact = false,
}: {
  service: Pick<IntegrationService, "id" | "name" | "category" | "logoUrl">;
  compact?: boolean;
}) {
  const [imageFailed, setImageFailed] = useState(false);
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
}

function categoryColor(category: string): string {
  if (category === "google") return palette.blue[50];
  if (category === "communication") return palette.green[100];
  return palette.neutral[100];
}

const styles = StyleSheet.create({
  container: {
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  fallback: {
    fontFamily: mockFonts.semibold,
    fontSize: 16,
    color: palette.neutral[700],
  },
  fallbackCompact: {
    fontSize: 13,
  },
});

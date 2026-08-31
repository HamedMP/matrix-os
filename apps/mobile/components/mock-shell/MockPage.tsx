import type { ReactNode } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";

import { Spacer } from "@/components/ui";
import { mockColors, mockFonts } from "./theme";

interface MockPageProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
}

export function MockPage({
  title,
  subtitle,
  children,
  scroll = true,
  refreshing = false,
  onRefresh,
}: MockPageProps) {
  const content = (
    <View testID="mock-page-content" style={styles.content}>
      <Spacer size="lg" />
      <View testID="mock-page-heading" style={styles.heading}>
        <Text style={styles.title}>{title}</Text>
        {subtitle ? (
          <>
            <Spacer size="xs" />
            <Text style={styles.subtitle}>{subtitle}</Text>
          </>
        ) : null}
      </View>
      <Spacer size="xl" />
      {children}
      <Spacer size="3xl" />
    </View>
  );

  return (
    <View style={styles.screen}>
      {scroll ? (
        <ScrollView
          alwaysBounceVertical={Boolean(onRefresh)}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          refreshControl={onRefresh ? (
            <RefreshControl
              testID="mock-page-refresh-control"
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={mockColors.ink}
              colors={[mockColors.ink]}
              progressBackgroundColor={mockColors.canvas}
            />
          ) : undefined}
        >
          {content}
        </ScrollView>
      ) : content}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: mockColors.canvas,
  },
  scrollContent: {
    flexGrow: 1,
  },
  content: {
    flex: 1,
    paddingHorizontal: 20,
  },
  heading: {},
  title: {
    fontFamily: mockFonts.display,
    fontSize: 28,
    letterSpacing: -0.7,
    color: mockColors.ink,
  },
  subtitle: {
    fontFamily: mockFonts.body,
    fontSize: 14,
    lineHeight: 20,
    color: mockColors.muted,
  },
});

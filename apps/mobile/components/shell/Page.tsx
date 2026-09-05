import type { ReactNode } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { Spacer } from "@/components/ui";

interface PageProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
}

export function Page({
  title,
  subtitle,
  children,
  scroll = true,
  refreshing = false,
  onRefresh,
}: PageProps) {
  const { theme } = useUnistyles();
  const content = (
    <View testID="page-content" style={styles.content}>
      <Spacer size="lg" />
      <View testID="page-heading" style={styles.heading}>
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
              testID="page-refresh-control"
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={theme.v2.appColors.ink}
              colors={[theme.v2.appColors.ink]}
              progressBackgroundColor={theme.v2.appColors.canvas}
            />
          ) : undefined}
        >
          {content}
        </ScrollView>
      ) : content}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: {
    flex: 1,
    backgroundColor: theme.v2.appColors.canvas,
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
    fontFamily: theme.v2.fonts.display,
    fontSize: 28,
    letterSpacing: -0.7,
    color: theme.v2.appColors.ink,
  },
  subtitle: {
    fontFamily: theme.v2.fonts.body,
    fontSize: 14,
    lineHeight: 20,
    color: theme.v2.appColors.muted,
  },
}));

import type { ReactNode } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { mockColors, mockFonts } from "./theme";

interface MockPageProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  scroll?: boolean;
}

export function MockPage({ title, subtitle, children, scroll = true }: MockPageProps) {
  const insets = useSafeAreaInsets();
  const content = (
    <View style={[styles.content, { paddingBottom: Math.max(insets.bottom, 20) + 20 }]}>
      <View style={styles.heading}>
        <Text style={styles.title}>{title}</Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      </View>
      {children}
    </View>
  );

  return (
    <View style={styles.screen}>
      {scroll ? (
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
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
    paddingTop: 18,
  },
  heading: {
    marginBottom: 22,
  },
  title: {
    fontFamily: mockFonts.display,
    fontSize: 28,
    letterSpacing: -0.7,
    color: mockColors.ink,
  },
  subtitle: {
    marginTop: 5,
    fontFamily: mockFonts.body,
    fontSize: 14,
    lineHeight: 20,
    color: mockColors.muted,
  },
});

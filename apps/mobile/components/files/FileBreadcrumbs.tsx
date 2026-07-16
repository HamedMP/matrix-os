import { Fragment } from "react";
import { Pressable, ScrollView, Text } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { breadcrumbs } from "@/lib/matrix-files";

export function FileBreadcrumbs({
  path,
  onNavigate,
}: {
  path: string;
  onNavigate: (path: string) => void;
}) {
  const { theme } = useUnistyles();
  const crumbs = breadcrumbs(path);

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.content}
      style={styles.container}
    >
      {crumbs.map((crumb, index) => {
        const isLast = index === crumbs.length - 1;
        return (
          <Fragment key={crumb.path || "home"}>
            {index > 0 ? (
              <Ionicons name="chevron-forward" size={13} color={theme.colors.mutedForeground} style={styles.sep} />
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Go to ${crumb.name}`}
              disabled={isLast}
              onPress={() => onNavigate(crumb.path)}
              style={({ pressed }) => [styles.crumb, pressed && !isLast && styles.crumbPressed]}
            >
              {index === 0 ? (
                <Ionicons
                  name="home"
                  size={13}
                  color={isLast ? theme.colors.foreground : theme.colors.primary}
                  style={styles.homeIcon}
                />
              ) : null}
              <Text style={isLast ? styles.crumbTextActive : styles.crumbText} numberOfLines={1}>
                {crumb.name}
              </Text>
            </Pressable>
          </Fragment>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flexGrow: 0 },
  content: { alignItems: "center", gap: 2, paddingVertical: theme.spacing.xs },
  sep: { marginHorizontal: 1 },
  crumb: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 5,
    borderRadius: theme.radius.md,
    maxWidth: 180,
  },
  crumbPressed: { backgroundColor: theme.colors.secondary },
  homeIcon: { marginTop: -1 },
  crumbText: { fontFamily: theme.fonts.sansMedium, fontSize: 13, color: theme.colors.primary },
  crumbTextActive: { fontFamily: theme.fonts.sansSemiBold, fontSize: 13, color: theme.colors.foreground },
}));

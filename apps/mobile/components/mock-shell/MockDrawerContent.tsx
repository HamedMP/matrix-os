import { Fragment, type ComponentProps } from "react";
import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, View } from "react-native";
import { DrawerContentScrollView, type DrawerContentComponentProps } from "expo-router/drawer";

import { Spacer, Text } from "@/components/ui";
import { designShadows, palette, semanticColors } from "@/lib/theme";
import { mockColors } from "./theme";

type IconName = ComponentProps<typeof Ionicons>["name"];

const primaryItems: Array<{ route: string; label: string; icon: IconName }> = [
  { route: "files", label: "Files", icon: "folder-outline" },
  { route: "terminal", label: "Terminal", icon: "terminal-outline" },
  { route: "integrations", label: "Integrations", icon: "extension-puzzle-outline" },
  { route: "apps", label: "Apps", icon: "grid-outline" },
];

const recentChats = ["matrix-os", "solar-vale", "Notes", "Launch plan"];

export function MockDrawerContent(props: DrawerContentComponentProps) {
  const activeRoute = props.state.routeNames[props.state.index];

  function navigate(route: string) {
    props.navigation.navigate(route);
    props.navigation.closeDrawer();
  }

  return (
    <View style={styles.root}>
      <DrawerContentScrollView {...props} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open Matrix OS home"
          hitSlop={8}
          onPress={() => navigate("index")}
          style={({ pressed }) => [styles.identity, pressed && styles.pressed]}
        >
          <Text size="large">Matrix OS</Text>
          <Spacer size="xs" />
          <Text size="muted" tone="subtle">solar-vale</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Search"
          hitSlop={10}
          onPress={() => navigate("search")}
          style={({ pressed }) => pressed && styles.pressed}
        >
          <Ionicons name="search-outline" size={24} color={mockColors.ink} />
        </Pressable>
      </View>

      <Spacer size="xl" />

      {primaryItems.map((item, index) => {
        const selected = activeRoute === item.route;
        return (
          <Fragment key={item.route}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={item.label}
              onPress={() => navigate(item.route)}
              style={({ pressed }) => [
                styles.padded,
                pressed && styles.pressed,
              ]}
            >
              <Spacer size="xxs" />
              <View style={styles.itemContainer}>
                <Ionicons
                  name={item.icon}
                  size={20}
                  style={styles.itemIcon}
                />
                <Text size="body">{item.label}</Text>
              </View>
              <Spacer size="xxs" />
            </Pressable>
            {index < primaryItems.length - 1 ? <Spacer size="sm" /> : null}
          </Fragment>
        );
      })}

      <Spacer size="xl" />
      <View style={styles.padded}>
        <Text size="overline" tone="subtle">Recents</Text>
      </View>
      <Spacer size="sm" />

      {recentChats.map((chat, index) => (
        <Fragment key={chat}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open recent chat ${chat}`}
            onPress={() => navigate("index")}
            style={({ pressed }) => [styles.padded, pressed && styles.pressed]}
          >
            <View style={styles.itemContainer}>
              <Ionicons
                name="chatbubble-outline"
                size={20}
                color={mockColors.ink}
                style={styles.itemIcon}
              />
              <Text size="body">{chat}</Text>
            </View>
          </Pressable>
          {index < recentChats.length - 1 ? <Spacer size="sm" /> : null}
        </Fragment>
      ))}
      </DrawerContentScrollView>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New chat"
        onPress={() => navigate("index")}
        style={({ pressed }) => [styles.newChat, pressed && styles.pressed]}
      >
        <Spacer size="sm" />
        <View style={styles.newChatContent}>
          <Ionicons
            name="pencil-outline"
            size={18}
            color={semanticColors.textInverse}
            style={styles.newChatIcon}
          />
          <Text size="body" tone="inverse">New chat</Text>
        </View>
        <Spacer size="sm" />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: mockColors.canvas,
  },
  content: {
    backgroundColor: mockColors.canvas,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
  },
  identity: {
    flex: 1,
  },
  padded: {
    paddingHorizontal: 8,
  },
  itemContainer: {
    flexDirection: "row",
    alignItems: "center",
  },
  itemIcon: {
    marginRight: 8,
  },
  pressed: {
    opacity: 0.65,
  },
  newChat: {
    position: "absolute",
    left: 16,
    bottom: 24,
    borderRadius: 999,
    paddingHorizontal: 16,
    backgroundColor: palette.green[800],
    boxShadow: designShadows.lg,
  },
  newChatContent: {
    flexDirection: "row",
    alignItems: "center",
  },
  newChatIcon: {
    marginRight: 8,
  },
});

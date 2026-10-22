import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { within } from "@testing-library/react-native";
import type { ReactTestInstance } from "react-test-renderer";

/**
 * Stands in for `@expo/ui/swift-ui`'s context menu: its items are drawn as
 * pressable rows beside what opens it, so a test can read and press them.
 * The rest of the module, which `@expo/ui`'s own sheets use, stays real.
 */
export function swiftUiContextMenuModule() {
  function ContextMenu({ children }: { children: ReactNode }) {
    return <View testID="context-menu">{children}</View>;
  }
  ContextMenu.Items = function ContextMenuItems({ children }: { children: ReactNode }) {
    return <View testID="context-menu-items">{children}</View>;
  };
  ContextMenu.Trigger = function ContextMenuTrigger({ children }: { children: ReactNode }) {
    return <View testID="context-menu-trigger">{children}</View>;
  };
  return {
    ...jest.requireActual<typeof import("@expo/ui/swift-ui")>("@expo/ui/swift-ui"),
    // Hands its settings on as a prop a test can read.
    Host: function Host({ children, ...settings }: { children: ReactNode; ignoreSafeArea?: string; matchContents?: unknown }) {
      return <View testID="swift-ui-host" {...{ hostSettings: settings }}>{children}</View>;
    },
    RNHostView: function RNHostView({ children }: { children: ReactNode }) {
      return children;
    },
    // Hands its modifiers on as a prop a test can read: the lifted preview's shape.
    Group: function Group({ children, modifiers }: { children: ReactNode; modifiers?: unknown[] }) {
      return <View testID="context-menu-preview" {...{ previewModifiers: modifiers }}>{children}</View>;
    },
    ContextMenu,
    // Hands its role on as a prop a test can read: "destructive" draws it in red.
    Button: function Button({ label, systemImage, role, onPress }: { label: string; systemImage?: string; role?: string; onPress?: () => void }) {
      return (
        <Pressable accessibilityRole="menuitem" accessibilityLabel={label} accessibilityHint={systemImage} onPress={onPress} {...{ menuRole: role }}>
          <Text>{label}</Text>
        </Pressable>
      );
    },
    // The system draws this row's label and opens its share sheet itself.
    ShareLink: function ShareLink({ item }: { item?: string }) {
      return <View testID="context-menu-share" accessible accessibilityRole="menuitem" accessibilityLabel="Share" accessibilityValue={{ text: item }} />;
    },
  };
}

/** The context menu that `element` opens. */
export function menuAround(element: ReactTestInstance): ReactTestInstance {
  let node: ReactTestInstance | null = element;
  while (node && node.props.testID !== "context-menu") node = node.parent;
  if (!node) throw new Error("No context menu around this element");
  return node;
}

/** Test IDs the stand-in above draws, to leave out of a reading of what the screen draws. */
export const CONTEXT_MENU_TEST_IDS: readonly string[] = [
  "swift-ui-host",
  "context-menu",
  "context-menu-items",
  "context-menu-share",
  "context-menu-trigger",
  "context-menu-preview",
];

/** The labels of a menu's items, in order. */
export function menuItemLabels(menu: ReactTestInstance): string[] {
  return within(menu).queryAllByRole("menuitem").map((item) => item.props.accessibilityLabel as string);
}

/** The item labelled `label` in the menu `element` opens. */
export function menuItem(element: ReactTestInstance, label: string): ReactTestInstance {
  return within(menuAround(element)).getByRole("menuitem", { name: label });
}

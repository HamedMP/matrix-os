import { cloneElement, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { Button, ContextMenu, Group, Host, RNHostView, ShareLink } from "@expo/ui/swift-ui";
import { contentShape, shapes } from "@expo/ui/swift-ui/modifiers";
import { StyleSheet } from "react-native-unistyles";

import type { ChatMenuActionId, ChatMenuTriggerProps } from "./chat-menu-actions";

const SYSTEM_IMAGES = {
  "copy-text": "doc.on.doc",
  "copy-chat-id": "number",
} satisfies Record<Exclude<ChatMenuActionId, "share">, ComponentProps<typeof Button>["systemImage"]>;

/**
 * iOS's chat menu: the system context menu. A long press lifts what is hosted
 * out of the screen, so only what the menu opens on is hosted: the row around
 * it stays React Native's, or the lift would light up the whole row first.
 */
export function ChatMenuTrigger({
  actions,
  onOpen,
  fit,
  cornerRadius,
  inset,
  backgroundColor,
  children,
}: ChatMenuTriggerProps) {
  const row = useRef<View>(null);
  // SwiftUI sizes hosted content by itself, so the content is given its
  // width from the row's; its height then follows the content.
  const [rowWidth, setRowWidth] = useState<number | null>(null);
  // Measured before the first paint, so the content is never drawn at its
  // natural width first. A row not laid out yet measures 0 wide; its layout
  // event follows.
  useLayoutEffect(() => {
    row.current?.measure((_x, _y, measured) => { if (measured > 0) setRowWidth(measured); });
  }, []);
  const onLayout = (event: LayoutChangeEvent) => {
    const measured = event.nativeEvent.layout.width;
    if (measured > 0) setRowWidth(measured);
  };
  const hug = fit === "end";
  // Content at its own size is bounded by the row, against which its own
  // percentages then resolve.
  const contentWidth = rowWidth === null ? undefined : hug ? { maxWidth: rowWidth } : { width: rowWidth };

  return (
    // The inset is padding inside what is hosted and lifted, taken back out
    // around it, so the content stays where it would be without it.
    <View ref={row} onLayout={onLayout} style={[styles.row, hug && styles.rowEnd, inset > 0 && { margin: -inset }]}>
      {/* Without this the hosting view lays the content out inside the
          window's safe areas, so a message under the top bar or the home
          indicator, or above the keyboard, is pushed within its own frame. */}
      <Host matchContents={hug ? true : { vertical: true }} ignoreSafeArea="all">
        <ContextMenu>
          <ContextMenu.Items>
            {actions.map((action) => (action.id === "share" ? (
              // The system's own Share row: its label, and the share sheet it opens.
              <ShareLink key={action.id} item={action.text} />
            ) : (
              <Button
                key={action.id}
                label={action.label}
                systemImage={SYSTEM_IMAGES[action.id]}
                onPress={action.onSelect}
              />
            )))}
          </ContextMenu.Items>
          <ContextMenu.Trigger>
            {/* The lifted preview takes these corners rather than the system's own. */}
            <Group modifiers={[contentShape(shapes.roundedRectangle({ cornerRadius }), "contextMenuPreview")]}>
              <RNHostView matchContents>
                <View style={[contentWidth, inset > 0 && { padding: inset }, backgroundColor !== undefined && { backgroundColor }]}>
                  {cloneElement(children, { onLongPress: onOpen })}
                </View>
              </RNHostView>
            </Group>
          </ContextMenu.Trigger>
        </ContextMenu>
      </Host>
    </View>
  );
}

const styles = StyleSheet.create({
  // Takes the whole row's width, so it can be measured whatever its parent aligns.
  row: {
    alignSelf: "stretch",
  },
  rowEnd: {
    alignItems: "flex-end",
  },
});

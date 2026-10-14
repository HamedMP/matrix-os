import { cloneElement, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { Button, ContextMenu, Host, RNHostView, ShareLink } from "@expo/ui/swift-ui";

import type { ChatMenuActionId, ChatMenuTriggerProps } from "./chat-menu-actions";

const SYSTEM_IMAGES = {
  "copy-text": "doc.on.doc",
  "copy-chat-id": "number",
} satisfies Record<Exclude<ChatMenuActionId, "share">, ComponentProps<typeof Button>["systemImage"]>;

/** iOS's chat menu: the system context menu, lifted out of the list by a long press. */
export function ChatMenuTrigger({ actions, onOpen, children }: ChatMenuTriggerProps) {
  const row = useRef<View>(null);
  // SwiftUI sizes hosted content by itself, so the content is given the
  // row's width; its height then follows the content.
  const [width, setWidth] = useState<number | null>(null);
  // Measured before the first paint, so the content is never drawn at its
  // natural width first. A row not laid out yet measures 0 wide; its layout
  // event follows.
  useLayoutEffect(() => {
    row.current?.measure((_x, _y, measured) => { if (measured > 0) setWidth(measured); });
  }, []);
  const onLayout = (event: LayoutChangeEvent) => {
    const measured = event.nativeEvent.layout.width;
    if (measured > 0) setWidth(measured);
  };

  return (
    <View ref={row} onLayout={onLayout}>
      <Host matchContents={{ vertical: true }}>
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
            <RNHostView matchContents>
              <View style={width === null ? undefined : { width }}>
                {cloneElement(children, { onLongPress: onOpen })}
              </View>
            </RNHostView>
          </ContextMenu.Trigger>
        </ContextMenu>
      </Host>
    </View>
  );
}

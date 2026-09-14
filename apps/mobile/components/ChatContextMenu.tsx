import { cloneElement, useEffect, useRef, type ReactElement } from "react";
import { Alert, type PressableProps } from "react-native";
import * as Clipboard from "expo-clipboard";

/** Native Mobile's long-press equivalent of the shared Chat context menu. */
export function ChatContextMenu({ chatId, children }: {
  chatId?: string | null;
  children: ReactElement<PressableProps>;
}) {
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    return () => { generation.current += 1; };
  }, [chatId]);
  if (!chatId) return children;
  return cloneElement(children, {
    onLongPress: () => {
      const attempt = ++generation.current;
      Alert.alert("Chat", undefined, [
        {
          text: "Copy chat ID",
          onPress: () => {
            if (attempt !== generation.current) return;
            void (async () => {
              try {
                const copied = await Clipboard.setStringAsync(chatId);
                if (copied === false) throw new Error("Clipboard unavailable");
                if (attempt === generation.current) Alert.alert("Chat ID copied");
              } catch (error: unknown) {
                console.warn("[chat] Clipboard copy failed", error instanceof Error ? "Error" : "UnknownError");
                if (attempt === generation.current) Alert.alert("Could not copy chat ID", "Try again.");
              }
            })();
          },
        },
        { text: "Cancel", style: "cancel" },
      ]);
    },
  });
}

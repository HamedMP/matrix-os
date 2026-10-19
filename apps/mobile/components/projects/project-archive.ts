import { Alert } from "react-native";

/** Asks before archiving a project, in the same words from its screen's menu and from its row's. */
export function confirmArchiveProject(name: string, onArchive: () => void): void {
  Alert.alert(`Archive ${name}?`, "It leaves your project list. Its chats are kept.", [
    { text: "Cancel", style: "cancel" },
    { text: "Archive", onPress: onArchive },
  ]);
}

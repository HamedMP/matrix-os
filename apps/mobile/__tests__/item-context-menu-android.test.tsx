import { fireEvent, render, screen } from "@testing-library/react-native";
import * as Haptics from "expo-haptics";
import { Alert, Pressable, Text, type AlertButton } from "react-native";

import { ItemContextMenu, type ItemMenuAction } from "../components/ItemContextMenu";

// Jest resolves the iOS files; this suite draws the menu Android draws.
jest.mock("../components/ChatMenuTrigger", () => jest.requireActual("../components/ChatMenuTrigger.tsx"));

function actions(onRename = jest.fn(), onArchive = jest.fn()): ItemMenuAction[] {
  return [
    { id: "item", key: "rename", label: "Rename", systemImage: "pencil", onSelect: onRename },
    { id: "item", key: "archive", label: "Archive", systemImage: "archivebox", destructive: true, onSelect: onArchive },
  ];
}

describe("ItemContextMenu on Android", () => {
  let alert: jest.SpyInstance;

  beforeEach(() => {
    alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    jest.mocked(Haptics.impactAsync).mockClear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("opens an alert titled with the item, its actions, the removing one marked, and Cancel", () => {
    const onArchive = jest.fn();
    render(
      <ItemContextMenu title="Q4 launch" actions={actions(jest.fn(), onArchive)}>
        <Pressable testID="row"><Text>Q4 launch</Text></Pressable>
      </ItemContextMenu>,
    );

    fireEvent(screen.getByTestId("row"), "longPress");

    const [title, , buttons] = alert.mock.calls.at(-1) as [string, undefined, AlertButton[]];
    expect(title).toBe("Q4 launch");
    expect(buttons.map((button) => [button.text, button.style])).toEqual([
      ["Rename", undefined],
      ["Archive", "destructive"],
      ["Cancel", "cancel"],
    ]);
    expect(Haptics.impactAsync).toHaveBeenCalledTimes(1);
    buttons[1]!.onPress?.();
    expect(onArchive).toHaveBeenCalledTimes(1);
  });

  it("draws the row with no menu when the item has nothing to offer", () => {
    render(
      <ItemContextMenu title="Notes" actions={[]}>
        <Pressable testID="row"><Text>Notes</Text></Pressable>
      </ItemContextMenu>,
    );

    fireEvent(screen.getByTestId("row"), "longPress");
    expect(alert).not.toHaveBeenCalled();
  });
});

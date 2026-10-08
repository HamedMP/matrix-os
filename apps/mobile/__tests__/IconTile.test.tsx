import { cleanup, render, screen } from "@testing-library/react-native";

import { Icon } from "../components/ui/Icon";
import { IconTile, type IconTileSize } from "../components/ui/IconTile";
import { AddIcon, FolderIcon } from "../components/ui/icons";

import { flat } from "./ui-test-utils";

describe("IconTile", () => {
  afterEach(cleanup);

  it.each<[IconTileSize, number, number]>([
    [36, 10, 18],
    [40, 9999, 18],
    [44, 12, 22],
    [52, 14, 24],
  ])("at %ipt uses radius %i and a %ipt icon on the card colour", (size, radius, iconSize) => {
    render(<IconTile testID="tile" icon={FolderIcon} size={size} />);

    expect(flat(screen.getByTestId("tile"))).toMatchObject({
      width: size,
      height: size,
      borderRadius: radius,
      backgroundColor: "#FAF9F7",
      alignItems: "center",
      justifyContent: "center",
    });
    expect(screen.UNSAFE_getByType(Icon).props).toMatchObject({ icon: FolderIcon, size: iconSize });
  });

  it("can be forced into a circle with its own icon size", () => {
    render(<IconTile testID="tile" icon={AddIcon} size={44} shape="circle" iconSize={20} />);

    expect(flat(screen.getByTestId("tile"))).toMatchObject({ width: 44, height: 44, borderRadius: 9999 });
    expect(screen.UNSAFE_getByType(Icon).props.size).toBe(20);
  });

  it("draws the icon in the text colour, or the secondary text colour when subtle", () => {
    render(<IconTile icon={FolderIcon} size={44} />);
    expect(screen.UNSAFE_getByType(Icon).props.color).toBe("#242323");
    cleanup();

    render(<IconTile icon={FolderIcon} size={40} tone="subtle" />);
    expect(screen.UNSAFE_getByType(Icon).props.color).toBe("#635F5F");
  });

  it("is decorative", () => {
    render(<IconTile testID="tile" icon={FolderIcon} size={44} />);

    const tile = screen.getByTestId("tile");
    expect(tile.props.accessibilityElementsHidden).toBe(true);
    expect(tile.props.importantForAccessibility).toBe("no-hide-descendants");
  });
});

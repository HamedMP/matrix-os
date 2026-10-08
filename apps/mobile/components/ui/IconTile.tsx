import { View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { Icon, type IconData } from "./Icon";

export type IconTileSize = 36 | 40 | 44 | 52;

export interface IconTileProps {
  icon: IconData;
  size: IconTileSize;
  /** `circle` rounds the tile fully whatever its size. */
  shape?: "rounded" | "circle";
  iconSize?: number;
  /** `subtle` draws the icon in the secondary text colour. */
  tone?: "default" | "subtle";
  testID?: string;
}

const ICON_SIZE: Record<IconTileSize, number> = { 36: 18, 40: 18, 44: 22, 52: 24 };

/** A card-coloured ground behind an icon, used as the leading element of a row. */
export function IconTile({
  icon,
  size,
  shape = "rounded",
  iconSize,
  tone = "default",
  testID,
}: IconTileProps) {
  const { theme } = useUnistyles();
  const iconColor = tone === "subtle" ? theme.v2.colors.textSubtle : theme.v2.colors.textDefault;

  return (
    <View
      testID={testID}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.tile,
        styles[`size${size}`],
        shape === "circle" && styles.circle,
        { width: size, height: size },
      ]}
    >
      <Icon icon={icon} size={iconSize ?? ICON_SIZE[size]} color={iconColor} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  tile: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.v2.colors.card,
  },
  size36: {
    borderRadius: theme.v2.radius.control,
  },
  size40: {
    borderRadius: theme.v2.radius.full,
  },
  size44: {
    borderRadius: theme.v2.radius.card,
  },
  size52: {
    borderRadius: theme.v2.radius.field,
  },
  circle: {
    borderRadius: theme.v2.radius.full,
  },
}));

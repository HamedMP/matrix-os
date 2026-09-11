import {
  HugeiconsIcon,
  type HugeiconsProps,
  type IconSvgElement,
} from "@hugeicons/react-native";
import { useUnistyles } from "react-native-unistyles";

export type IconData = IconSvgElement;

export interface IconProps extends Omit<HugeiconsProps, "icon"> {
  icon: IconData;
}

/** Shared HugeIcons renderer. Icon data must be imported from a direct subpath. */
export function Icon({
  icon,
  size = 20,
  color,
  strokeWidth = 1.5,
  ...props
}: IconProps) {
  const { theme } = useUnistyles();

  return (
    <HugeiconsIcon
      {...props}
      icon={icon}
      size={size}
      color={color ?? theme.v2.colors.textDefault}
      strokeWidth={strokeWidth}
    />
  );
}

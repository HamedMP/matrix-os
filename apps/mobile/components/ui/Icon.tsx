import {
  HugeiconsIcon,
  type HugeiconsProps,
  type IconSvgElement,
} from "@hugeicons/react-native";
import { semanticColors } from "@/lib/theme";

export type IconData = IconSvgElement;

export interface IconProps extends Omit<HugeiconsProps, "icon"> {
  icon: IconData;
}

/** Shared HugeIcons renderer. Icon data must be imported from a direct subpath. */
export function Icon({
  icon,
  size = 20,
  color = semanticColors.textDefault,
  strokeWidth = 1.5,
  ...props
}: IconProps) {
  return (
    <HugeiconsIcon
      {...props}
      icon={icon}
      size={size}
      color={color}
      strokeWidth={strokeWidth}
    />
  );
}

import type { ReactNode } from "react";
import {
  Text as NativeText,
  type TextProps as NativeTextProps,
  type TextStyle,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  semanticColors,
  spacing,
  typography,
  type SpacingSize,
} from "@/lib/theme";

export type TextTone =
  | "default"
  | "subtle"
  | "inverse"
  | "brand"
  | "action"
  | "success"
  | "highlight"
  | "info";

interface TypographyProps extends Omit<NativeTextProps, "children" | "style"> {
  children: ReactNode;
  /** Horizontal space belongs to the component; vertical space belongs to Spacer. */
  horizontalInset?: SpacingSize | "none";
  tone?: TextTone;
  align?: TextStyle["textAlign"];
}

export interface TitleProps extends TypographyProps {
  size?: "h1" | "h2" | "h3";
}

export interface SubtitleProps extends TypographyProps {
  size?: "large" | "body" | "muted";
}

export interface TextProps extends TypographyProps {
  size?: "large" | "body" | "muted" | "overline";
}

function ProductText({
  children,
  horizontalInset = "none",
  tone = "default",
  align = "left",
  typographyStyle,
  ...props
}: TypographyProps & { typographyStyle: TextStyle }) {
  const inset = horizontalInset === "none" ? 0 : spacing[horizontalInset];

  return (
    <NativeText
      {...props}
      style={[
        styles.base,
        typographyStyle,
        toneStyles[tone],
        { paddingHorizontal: inset, textAlign: align },
      ]}
    >
      {children}
    </NativeText>
  );
}

export function Title({ size = "h1", accessibilityRole = "header", ...props }: TitleProps) {
  return (
    <ProductText
      {...props}
      accessibilityRole={accessibilityRole}
      typographyStyle={typography[size]}
    />
  );
}

export function Subtitle({ size = "large", tone = "subtle", ...props }: SubtitleProps) {
  return (
    <ProductText
      {...props}
      tone={tone}
      typographyStyle={typography[size]}
    />
  );
}

export function Text({ size = "body", ...props }: TextProps) {
  return <ProductText {...props} typographyStyle={typography[size]} />;
}

// Static tokens keep route-module evaluation safe. Expo Router may import this
// file before the root layout has run the Unistyles configuration side effect.
const styles = StyleSheet.create({
  base: {
    color: semanticColors.textDefault,
    flexShrink: 1,
  },
  default: { color: semanticColors.textDefault },
  subtle: { color: semanticColors.textSubtle },
  inverse: { color: semanticColors.textInverse },
  brand: { color: semanticColors.brand },
  action: { color: semanticColors.action },
  success: { color: semanticColors.success },
  highlight: { color: semanticColors.highlight },
  info: { color: semanticColors.info },
});

const toneStyles = {
  default: styles.default,
  subtle: styles.subtle,
  inverse: styles.inverse,
  brand: styles.brand,
  action: styles.action,
  success: styles.success,
  highlight: styles.highlight,
  info: styles.info,
} as const;

import type { ReactNode } from "react";
import {
  Text as NativeText,
  type TextProps as NativeTextProps,
  type TextStyle,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  spacing,
  typography,
  type SpacingSize,
} from "@/lib/theme-v2";

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
        styles[tone],
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

const styles = StyleSheet.create((theme) => ({
  base: {
    color: theme.v2.colors.textDefault,
    flexShrink: 1,
  },
  default: { color: theme.v2.colors.textDefault },
  subtle: { color: theme.v2.colors.textSubtle },
  inverse: { color: theme.v2.colors.textInverse },
  brand: { color: theme.v2.colors.brand },
  action: { color: theme.v2.colors.action },
  success: { color: theme.v2.colors.success },
  highlight: { color: theme.v2.colors.highlight },
  info: { color: theme.v2.colors.info },
}));

import { Image } from "expo-image";
import { useUnistyles } from "react-native-unistyles";

import { providerArtwork, type ArtworkProvider } from "@/lib/provider-logos";

import { RabbitMark } from "./RabbitMark";

export type Provider = "matrix" | ArtworkProvider;

export interface ProviderLogoProps {
  provider: Provider;
  size?: number;
  /** Colour for the mark and the glyphs; defaults to the engine's own colour, then the text colour. */
  color?: string;
  testID?: string;
}

/** The logo of the engine a chat runs with. Decorative: the label beside it names the engine. */
export function ProviderLogo({ provider, size = 18, color, testID }: ProviderLogoProps) {
  const { theme } = useUnistyles();

  if (provider === "matrix") {
    return <RabbitMark testID={testID} height={size} color={color} />;
  }

  const artwork = providerArtwork[provider];
  return (
    <Image
      testID={testID}
      source={artwork.source}
      contentFit="contain"
      tintColor={artwork.glyph ? color ?? artwork.brandColor ?? theme.v2.colors.textDefault : undefined}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size }}
    />
  );
}

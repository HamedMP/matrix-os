import { Image } from "expo-image";
import { useUnistyles } from "react-native-unistyles";

const rabbitArtwork = require("../../assets/app.icon/Assets/rabbit.svg");

// The mark is drawn 30.9 wide for every 40 of height.
const ASPECT_RATIO = 30.9 / 40;

export interface RabbitMarkProps {
  height?: number;
  /** Defaults to the text colour. */
  color?: string;
  testID?: string;
}

/** The Matrix mark. Decorative: whatever it sits beside carries the name. */
export function RabbitMark({ height = 40, color, testID }: RabbitMarkProps) {
  const { theme } = useUnistyles();

  return (
    <Image
      testID={testID}
      source={rabbitArtwork}
      contentFit="contain"
      tintColor={color ?? theme.v2.colors.textDefault}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: height * ASPECT_RATIO, height }}
    />
  );
}

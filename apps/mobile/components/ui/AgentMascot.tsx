import { View } from "react-native";
import Svg, { Circle, G, Path, Rect } from "react-native-svg";

import {
  deriveAgentMascot,
  MASCOT_EYE,
  MASCOT_INNER_EAR_WIDTH,
  MASCOT_NOSE,
  MASCOT_VIEW_BOX,
} from "@/lib/agent-mascot";

export interface AgentMascotProps {
  /** Decides the face, ears, eyes and nose, so an agent always looks the same. */
  id: string;
  /** Read out as the image's name. */
  name: string;
  /** Decides the body colour. */
  category?: string;
  size?: number;
  testID?: string;
}

/** An agent's rabbit, in its idle pose. */
export function AgentMascot({ id, name, category, size = 36, testID }: AgentMascotProps) {
  const mascot = deriveAgentMascot(id, category);

  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="image"
      accessibilityLabel={name}
      style={{ width: size, height: size }}
    >
      <Svg width={size} height={size} viewBox={MASCOT_VIEW_BOX}>
        {mascot.ears.map((ear) => (
          <G key={ear.d} transform={ear.transform}>
            <Path d={ear.d} fill={mascot.body} />
            <Path
              d={ear.inner}
              fill="none"
              stroke={mascot.wash}
              strokeWidth={MASCOT_INNER_EAR_WIDTH}
              strokeLinecap="round"
            />
          </G>
        ))}
        <Path d={mascot.face} fill={mascot.body} />
        {mascot.eyes.map((eye) => (
          <Rect key={eye.transform} {...MASCOT_EYE} x={eye.x} transform={eye.transform} />
        ))}
        {mascot.hasNose ? <Circle {...MASCOT_NOSE} fill={mascot.wash} /> : null}
      </Svg>
    </View>
  );
}

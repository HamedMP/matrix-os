import { render, screen } from "@testing-library/react-native";
import { Text } from "react-native";

import { ListItemMotion, SettleIn } from "../components/ui/ListMotion";

function animationName(value: unknown) {
  return (value as { animationName?: string } | undefined)?.animationName;
}

describe("list motion", () => {
  it("fades a list in once as it replaces its placeholders, not row by row", () => {
    render(<SettleIn testID="settled"><ListItemMotion testID="row"><Text>Row</Text></ListItemMotion></SettleIn>);

    expect(animationName(screen.getByTestId("settled").props.entering)).toBe("FadeIn");
    expect(screen.getByTestId("row").props.entering).toBeUndefined();
  });

  it("fades out a row that leaves, while the rows after it move up into place", () => {
    render(<ListItemMotion testID="row"><Text>Row</Text></ListItemMotion>);

    const row = screen.getByTestId("row");
    expect(animationName(row.props.exiting)).toBe("FadeOut");
    expect(animationName(row.props.layout)).toBe("LinearTransition");
  });
});

import { cleanup, render, screen } from "@testing-library/react-native";
import { Image } from "expo-image";
import { StyleSheet as NativeStyleSheet } from "react-native";

import { RabbitMark } from "../components/ui/RabbitMark";

const rabbitArtwork = require("../assets/app.icon/Assets/rabbit.svg");

function imageProps() {
  const { style, ...props } = screen.UNSAFE_getByType(Image).props;
  return { ...props, style: NativeStyleSheet.flatten(style) as Record<string, number> };
}

describe("RabbitMark", () => {
  afterEach(cleanup);

  it("draws the Matrix mark 40pt high in the text colour, keeping the 30.9 to 40 ratio", () => {
    render(<RabbitMark />);

    const image = imageProps();
    expect(image.source).toBe(rabbitArtwork);
    expect(image.tintColor).toBe("#242323");
    expect(image.contentFit).toBe("contain");
    expect(image.style.height).toBe(40);
    expect(image.style.width).toBeCloseTo(30.9, 5);
  });

  it("scales its width with its height", () => {
    render(<RabbitMark height={20} />);

    const image = imageProps();
    expect(image.style.height).toBe(20);
    expect(image.style.width).toBeCloseTo(15.45, 5);
  });

  it("can be drawn in another colour", () => {
    render(<RabbitMark color="#FFFFFF" />);

    expect(imageProps().tintColor).toBe("#FFFFFF");
  });

  it("is decorative", () => {
    render(<RabbitMark />);

    expect(imageProps()).toMatchObject({
      accessible: false,
      accessibilityElementsHidden: true,
      importantForAccessibility: "no-hide-descendants",
    });
  });
});

import { cleanup, render, screen } from "@testing-library/react-native";
import { Image } from "expo-image";
import { StyleSheet as NativeStyleSheet } from "react-native";

import { ProviderLogo, type Provider } from "../components/ui/ProviderLogo";
import { RabbitMark } from "../components/ui/RabbitMark";

const LOGOS: Record<Exclude<Provider, "matrix">, unknown> = {
  claude: require("../../../shell/public/agent-logos/claude-code.png"),
  codex: require("../../../shell/public/agent-logos/codex.png"),
  hermes: require("../../../shell/public/agent-logos/hermes-agent.png"),
  openclaw: require("../../../shell/public/agent-logos/openclaw.svg"),
  opencode: require("../../../shell/public/agent-logos/opencode-white.png"),
  pi: require("../../../shell/public/agent-logos/pi-coding-agent.png"),
};

function imageProps() {
  const { style, ...props } = screen.UNSAFE_getByType(Image).props;
  return { ...props, style: NativeStyleSheet.flatten(style) as Record<string, number> };
}

describe("ProviderLogo", () => {
  afterEach(cleanup);

  it("draws the rabbit mark for Matrix at the logo's height", () => {
    render(<ProviderLogo provider="matrix" />);

    expect(screen.UNSAFE_getByType(RabbitMark).props).toMatchObject({ height: 18 });
    expect(imageProps().tintColor).toBe("#242323");
  });

  it.each<Exclude<Provider, "matrix">>(["claude", "codex", "hermes", "openclaw", "opencode", "pi"])(
    "draws the shipped %s artwork in an 18pt box",
    (provider) => {
      render(<ProviderLogo provider={provider} />);

      const image = imageProps();
      expect(image.source).toBe(LOGOS[provider]);
      expect(image.contentFit).toBe("contain");
      expect(image.style).toMatchObject({ width: 18, height: 18 });
    },
  );

  // These three files are white glyphs on a transparent ground with no colour of their own.
  it.each<Provider>(["codex", "opencode", "pi"])("tints the %s glyph with the text colour", (provider) => {
    render(<ProviderLogo provider={provider} />);

    expect(imageProps().tintColor).toBe("#242323");
  });

  it("draws the Claude glyph in its own orange unless a colour is given", () => {
    render(<ProviderLogo provider="claude" />);
    expect(imageProps().tintColor).toBe("#E3925A");
    cleanup();

    render(<ProviderLogo provider="claude" color="#FFFFFF" />);
    expect(imageProps().tintColor).toBe("#FFFFFF");
  });

  it.each<Provider>(["hermes", "openclaw"])("leaves the %s artwork in its own colours", (provider) => {
    render(<ProviderLogo provider={provider} color="#FFFFFF" />);

    expect(imageProps().tintColor).toBeUndefined();
  });

  it("takes a size", () => {
    render(<ProviderLogo provider="codex" size={20} />);

    expect(imageProps().style).toMatchObject({ width: 20, height: 20 });
  });

  it.each<Provider>(["matrix", "pi"])("draws the %s glyph in a given colour", (provider) => {
    render(<ProviderLogo provider={provider} color="#FFFFFF" />);

    expect(imageProps().tintColor).toBe("#FFFFFF");
  });

  it("is decorative", () => {
    render(<ProviderLogo provider="claude" />);

    expect(imageProps()).toMatchObject({
      accessible: false,
      accessibilityElementsHidden: true,
      importantForAccessibility: "no-hide-descendants",
    });
  });
});

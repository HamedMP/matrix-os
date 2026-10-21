import { render, screen } from "@testing-library/react-native";
import { Image } from "expo-image";

import { AppLogo } from "../components/apps/AppLogo";
import { IntegrationLogo } from "../components/integrations/IntegrationLogo";
import { motion } from "../lib/theme-v2";

describe("logos from the computer", () => {
  it("fade in as they load instead of popping in", () => {
    render(
      <>
        <AppLogo name="Notes" uri="https://computer.example.test/icons/notes.png" />
        <IntegrationLogo
          service={{ id: "github", name: "GitHub", category: "dev", logoUrl: "https://logos.example.test/github.png" } as never}
        />
      </>,
    );

    const images = screen.UNSAFE_getAllByType(Image);
    expect(images).toHaveLength(2);
    for (const image of images) expect(image.props.transition).toBe(motion.duration.fast);
  });
});

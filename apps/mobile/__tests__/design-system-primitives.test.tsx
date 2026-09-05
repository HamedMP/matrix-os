import { render, screen } from "@testing-library/react-native";
import { StyleSheet as NativeStyleSheet } from "react-native";
import { Spacer, Subtitle, Text, Title } from "@/components/ui";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("design-system primitives", () => {
  it("does not resolve the Unistyles theme while the route module is loading", () => {
    const source = readFileSync(join(__dirname, "../components/ui/Typography.tsx"), "utf8");

    expect(source).not.toContain("StyleSheet.create((theme)");
    expect(source).not.toContain("useUnistyles");
  });

  it("renders each title size from the shared typography scale", () => {
    render(
      <>
        <Title size="h1">Display</Title>
        <Title size="h2">Heading</Title>
        <Title size="h3">Subheading</Title>
      </>,
    );

    expect(NativeStyleSheet.flatten(screen.getByText("Display").props.style)).toMatchObject({
      fontFamily: "Geist_800ExtraBold",
      fontSize: 36,
    });
    expect(NativeStyleSheet.flatten(screen.getByText("Heading").props.style)).toMatchObject({
      fontFamily: "Geist_600SemiBold",
      fontSize: 30,
    });
    expect(NativeStyleSheet.flatten(screen.getByText("Subheading").props.style)).toMatchObject({
      fontFamily: "Geist_600SemiBold",
      fontSize: 24,
    });
  });

  it("supports subtitle and body sizes without vertical spacing", () => {
    render(
      <>
        <Subtitle size="large">A subtitle</Subtitle>
        <Text size="body" horizontalInset="xl">Body copy</Text>
        <Text size="overline">Section</Text>
      </>,
    );

    const subtitle = NativeStyleSheet.flatten(screen.getByText("A subtitle").props.style);
    const body = NativeStyleSheet.flatten(screen.getByText("Body copy").props.style);
    const overline = NativeStyleSheet.flatten(screen.getByText("Section").props.style);

    expect(subtitle).toMatchObject({ fontSize: 18, color: "#635F5F" });
    expect(body).toMatchObject({ fontSize: 16, lineHeight: 28, paddingHorizontal: 24 });
    expect(body.marginTop).toBeUndefined();
    expect(body.marginBottom).toBeUndefined();
    expect(body.paddingTop).toBeUndefined();
    expect(body.paddingBottom).toBeUndefined();
    expect(overline).toMatchObject({ fontSize: 11, textTransform: "uppercase" });
  });

  it("uses Spacer as the only vertical rhythm primitive", () => {
    render(
      <>
        <Spacer testID="small-space" size="xs" />
        <Spacer testID="large-space" size="4xl" />
      </>,
    );

    expect(NativeStyleSheet.flatten(screen.getByTestId("small-space").props.style)).toMatchObject({ height: 4 });
    expect(NativeStyleSheet.flatten(screen.getByTestId("large-space").props.style)).toMatchObject({ height: 64 });
  });
});

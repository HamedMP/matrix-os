import React from "react";
import { render, screen } from "@testing-library/react-native";
import { StyleSheet as NativeStyleSheet } from "react-native";

import { Skeleton } from "@/components/ui";
import { semanticColors } from "@/lib/theme";

describe("Skeleton", () => {
  it("owns the skeleton fill and shimmer while accepting layout styles", () => {
    render(
      <Skeleton
        testID="shared-skeleton"
        shimmerTestID="shared-skeleton-shimmer"
        style={{ width: 120, height: 66, borderRadius: 16 }}
      />,
    );

    expect(NativeStyleSheet.flatten(screen.getByTestId("shared-skeleton").props.style)).toMatchObject({
      width: 120,
      height: 66,
      borderRadius: 16,
      backgroundColor: semanticColors.accentSurface,
      overflow: "hidden",
    });
    expect(screen.getByTestId("shared-skeleton-shimmer")).toBeTruthy();
  });
});

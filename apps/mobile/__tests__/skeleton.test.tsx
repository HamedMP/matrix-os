import React from "react";
import { render, screen } from "@testing-library/react-native";
import { StyleSheet as NativeStyleSheet } from "react-native";

import { GridTileSkeletonGrid, ListRowSkeletonStack } from "@/components/shell/Controls";
import { Skeleton } from "@/components/ui";

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
      backgroundColor: "#F2F2F0",
      overflow: "hidden",
    });
    expect(screen.getByTestId("shared-skeleton-shimmer")).toBeTruthy();
  });

  it("is a neutral grey with a lighter band sweeping across, with no tint", () => {
    render(<Skeleton testID="shared-skeleton" shimmerTestID="shared-skeleton-shimmer" />);

    expect(NativeStyleSheet.flatten(screen.getByTestId("shared-skeleton").props.style).backgroundColor).toBe("#F2F2F0");
    expect(NativeStyleSheet.flatten(screen.getByTestId("shared-skeleton-shimmer").props.style).backgroundColor)
      .toBe("rgba(255, 255, 255, 0.7)");
  });

  it("draws list row and grid tile placeholders as plain grey blocks, with no outline", () => {
    render(
      <>
        <ListRowSkeletonStack count={1} />
        <GridTileSkeletonGrid />
      </>,
    );

    const row = NativeStyleSheet.flatten(screen.getByTestId("list-row-skeleton").props.style);
    expect(row).toMatchObject({ height: 66, borderRadius: 16, backgroundColor: "#F2F2F0" });
    expect(row.borderWidth).toBeUndefined();
    expect(row.borderColor).toBeUndefined();

    const tile = NativeStyleSheet.flatten(screen.getAllByTestId("grid-tile-skeleton")[0].props.style);
    expect(tile).toMatchObject({ aspectRatio: 0.9, borderRadius: 18, backgroundColor: "#F2F2F0" });
    expect(tile.borderWidth).toBeUndefined();
    expect(tile.borderColor).toBeUndefined();
  });
});

import React from "react";
import { act, render, screen } from "@testing-library/react-native";
import { AccessibilityInfo, StyleSheet as NativeStyleSheet } from "react-native";

import { GridTileSkeletonGrid, ListRowSkeletonStack } from "@/components/shell/Controls";
import { ItemRowSkeletons, Skeleton } from "@/components/ui";

import { resetReduceMotion } from "./ui-test-utils";

describe("Skeleton", () => {
  beforeEach(resetReduceMotion);
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

  it("holds still, with no band, when the person has asked for reduced motion", async () => {
    jest.mocked(AccessibilityInfo.isReduceMotionEnabled).mockResolvedValue(true);
    render(<Skeleton testID="shared-skeleton" shimmerTestID="shared-skeleton-shimmer" />);
    await act(async () => {});

    expect(screen.getByTestId("shared-skeleton")).toBeTruthy();
    expect(screen.queryByTestId("shared-skeleton-shimmer")).toBeNull();
  });

  it("draws app tile placeholders as an icon and a label, with no tile behind them", () => {
    render(<GridTileSkeletonGrid testID="app-tile-skeleton" variant="icon" />);

    const tile = NativeStyleSheet.flatten(screen.getAllByTestId("app-tile-skeleton")[0].props.style);
    expect(tile).toMatchObject({ width: "31.5%", aspectRatio: 0.9, alignItems: "center" });
    expect(tile.backgroundColor).toBeUndefined();
    expect(NativeStyleSheet.flatten(screen.getAllByTestId("app-tile-skeleton-icon")[0].props.style))
      .toMatchObject({ width: 64, height: 64, backgroundColor: "#F2F2F0" });
    expect(screen.getAllByTestId("app-tile-skeleton-label")).toHaveLength(3);
  });
});

describe("ItemRowSkeletons", () => {
  function rows(testID: string) {
    return screen.getAllByTestId(testID);
  }

  it("draws rows as tall as the ItemRows they stand for, with no card around them", () => {
    render(<ItemRowSkeletons testID="row" count={2} leadingSize={44} leadingShape="tile" density="comfortable" gap={14} />);

    expect(rows("row")).toHaveLength(2);
    const row = NativeStyleSheet.flatten(rows("row")[0].props.style);
    expect(row).toMatchObject({ flexDirection: "row", alignItems: "center", paddingVertical: 12 });
    expect(row.backgroundColor).toBeUndefined();
    expect(row.borderWidth).toBeUndefined();

    const first = (part: string) => NativeStyleSheet.flatten(screen.getAllByTestId(`row-${part}`)[0].props.style);
    expect(first("picture")).toMatchObject({
      width: 44, height: 44, marginRight: 14, borderRadius: 12, backgroundColor: "#F2F2F0",
    });
    // A title line and a subtitle line: 22 + 2 + 18, like ItemRow's text.
    expect(first("lines")).toMatchObject({ gap: 2 });
    expect(first("title-line")).toMatchObject({ height: 22 });
    expect(first("subtitle-line")).toMatchObject({ height: 18 });
  });

  it("rounds the picture for round leading pictures and takes the compact padding by default", () => {
    render(<ItemRowSkeletons testID="row" leadingSize={36} leadingShape="round" />);

    expect(rows("row")).toHaveLength(3);
    expect(NativeStyleSheet.flatten(rows("row")[0].props.style)).toMatchObject({ paddingVertical: 10 });
    expect(NativeStyleSheet.flatten(screen.getAllByTestId("row-picture")[0].props.style)).toMatchObject({
      width: 36, height: 36, marginRight: 12, borderRadius: 9999,
    });
  });
});

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

const SCROLL_EVENT_INTERVAL_MS = 16;

export interface ModelSheetChipRowProps {
  testID: string;
  chips: { id: string; chip: ReactNode }[];
  /** The chip to keep in view, if any. */
  shownId: string | null;
}

interface Measured {
  /** The width of the row, the chips' places in its content, and how far it is scrolled. */
  width: number;
  frames: Record<string, { x: number; width: number }>;
  offset: number;
  /** The chip last brought into view. Undefined until the first one has been. */
  revealedId?: string;
}

/**
 * A row of chips that scrolls sideways and keeps one of them in view. That
 * chip is brought fully into view at once when the row is first laid out, and
 * with a glide whenever another takes its place.
 */
export function ModelSheetChipRow({ testID, chips, shownId }: ModelSheetChipRowProps) {
  const scroll = useRef<ScrollView>(null);
  const measured = useRef<Measured>({ width: 0, frames: {}, offset: 0 });

  const reveal = useCallback(() => {
    if (shownId === null) return;
    const row = measured.current;
    const frame = row.frames[shownId];
    if (!frame || row.width === 0 || row.revealedId === shownId) return;
    const animated = row.revealedId !== undefined;
    row.revealedId = shownId;

    const end = frame.x + frame.width;
    if (frame.x >= row.offset && end <= row.offset + row.width) return;
    // A chip wider than the row shows its start.
    const x = frame.x < row.offset || frame.width > row.width ? frame.x : end - row.width;
    row.offset = x;
    scroll.current?.scrollTo({ x, animated });
  }, [shownId]);

  // A chip that is already measured is revealed as soon as it becomes the one
  // shown. One that is not, or a row that is not, is revealed from its layout.
  useEffect(reveal, [reveal]);

  return (
    <ScrollView
      ref={scroll}
      testID={testID}
      horizontal
      showsHorizontalScrollIndicator={false}
      scrollEventThrottle={SCROLL_EVENT_INTERVAL_MS}
      onScroll={(event) => {
        measured.current.offset = event.nativeEvent.contentOffset.x;
      }}
      onLayout={(event) => {
        measured.current.width = event.nativeEvent.layout.width;
        reveal();
      }}
      style={styles.row}
      contentContainerStyle={styles.chips}
    >
      {chips.map(({ id, chip }) => (
        // The slot only measures where its chip sits in the row.
        <View
          key={id}
          onLayout={(event) => {
            const { x, width } = event.nativeEvent.layout;
            measured.current.frames[id] = { x, width };
            reveal();
          }}
        >
          {chip}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  // A chip is drawn shorter than its tap target. The row gives it the rest
  // above and below, and takes the same back from the space around the row.
  row: {
    flexGrow: 0,
    marginVertical: -(theme.v2.size.tapTarget - theme.v2.size.chip) / 2,
  },
  chips: {
    gap: theme.v2.space[8],
    paddingVertical: (theme.v2.size.tapTarget - theme.v2.size.chip) / 2,
  },
}));

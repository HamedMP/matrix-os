import { useState } from "react";
import { ScrollView, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { Button, Sheet, SheetGrabber } from "@/components/ui";

import type { AgentInspiration } from "./agent-inspirations.generated";
import { TemplateSheetHead } from "./TemplateSheetHead";

// The share of the window's height the description may take before it scrolls.
const DESCRIPTION_HEIGHT_SHARE = 0.4;

export interface InspirationSheetProps {
  /** The inspiration being looked at. Null closes the sheet. */
  inspiration: AgentInspiration | null;
  onBuildInChat: () => void;
  onClose: () => void;
}

/**
 * The sheet over the gallery for an inspiration: what the agent would do, and
 * the way to build one like it in chat. The computer has no template for it,
 * so there is nothing here to create it with.
 */
export function InspirationSheet({ inspiration, onBuildInChat, onClose }: InspirationSheetProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  // The inspiration last chosen stays drawn while the sheet slides away.
  const [drawn, setDrawn] = useState(inspiration);
  if (inspiration && inspiration !== drawn) setDrawn(inspiration);

  return (
    <Sheet visible={inspiration !== null} onClose={onClose} testID="inspiration-sheet">
      {drawn ? (
        <View
          testID="inspiration-sheet-body"
          style={[styles.sheet, { paddingBottom: insets.bottom + theme.v2.space[10] }]}
        >
          <SheetGrabber testID="inspiration-sheet-grabber" />
          <TemplateSheetHead
            testID="inspiration-sheet-head"
            id={drawn.id}
            name={drawn.name}
            category={drawn.categories[0]}
            caption={drawn.categories.join(" · ")}
            onClose={onClose}
          />
          {/* A long description scrolls, so the button under it stays in reach
              on a small screen and with large text. */}
          <ScrollView
            testID="inspiration-sheet-description"
            alwaysBounceVertical={false}
            nestedScrollEnabled
            style={[styles.descriptionArea, { maxHeight: Math.round(height * DESCRIPTION_HEIGHT_SHARE) }]}
          >
            <Text style={styles.description}>{drawn.description}</Text>
          </ScrollView>
          <Button size="large" fullWidth label="Build in chat" onPress={onBuildInChat} />
        </View>
      ) : null}
    </Sheet>
  );
}

// The grabber brings the 10pt above it, so the sheet has no top padding.
const styles = StyleSheet.create((theme) => ({
  sheet: {
    gap: theme.v2.space[14],
    paddingHorizontal: theme.v2.space[20],
  },
  descriptionArea: {
    flexGrow: 0,
  },
  description: {
    ...theme.v2.text.callout,
    color: theme.v2.colors.textDefault,
  },
}));

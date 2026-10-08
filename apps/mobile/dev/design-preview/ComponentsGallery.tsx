import { ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { ButtonsSection, ChipsSection, SearchFieldSection, TextFieldSection } from "./ControlSections";
import {
  AgentMascotSection,
  CountBadgesSection,
  IconTilesSection,
  ProviderLogosSection,
  RabbitMarkSection,
  StatusDotsSection,
} from "./IdentitySections";
import { ItemRowsSection, SheetSection, TopBarSection } from "./LayoutSections";

/** Every shared component of the redesign, in each of its states. */
export function ComponentsGallery() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();

  return (
    <ScrollView
      testID="design-preview-components"
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
      style={styles.screen}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top, paddingBottom: insets.bottom + theme.v2.space[24] },
      ]}
    >
      <ButtonsSection />
      <ChipsSection />
      <TextFieldSection />
      <SearchFieldSection />
      <TopBarSection />
      <ItemRowsSection />
      <SheetSection />
      <StatusDotsSection />
      <CountBadgesSection />
      <IconTilesSection />
      <AgentMascotSection />
      <ProviderLogosSection />
      <RabbitMarkSection />
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: {
    flex: 1,
    backgroundColor: theme.v2.colors.background,
  },
  content: {
    paddingHorizontal: theme.v2.space[20],
  },
}));

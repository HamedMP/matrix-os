import { Drawer, DrawerToggleButton, type DrawerContentComponentProps } from "expo-router/drawer";

import { MockDrawerContent } from "@/components/mock-shell/MockDrawerContent";
import { mockColors, mockFonts } from "@/components/mock-shell/theme";

export default function DrawerLayout() {
  return (
    <Drawer
      drawerContent={(props: DrawerContentComponentProps) => <MockDrawerContent {...props} />}
      screenOptions={{
        drawerPosition: "left",
        drawerType: "slide",
        drawerStyle: { width: "84%", backgroundColor: mockColors.canvas },
        overlayColor: "rgba(18, 20, 19, 0.24)",
        swipeEnabled: true,
        swipeEdgeWidth: 800,
        headerShadowVisible: false,
        headerTitleAlign: "center",
        headerStyle: { backgroundColor: mockColors.canvas },
        headerTitleStyle: {
          fontFamily: mockFonts.semibold,
          fontSize: 15,
          color: mockColors.ink,
        },
        headerLeft: ({ tintColor }: { tintColor?: string }) => (
          <DrawerToggleButton tintColor={tintColor ?? mockColors.ink} accessibilityLabel="Open navigation" />
        ),
        sceneStyle: { backgroundColor: mockColors.canvas },
      }}
    >
      <Drawer.Screen name="index" options={{ title: "Matrix OS", drawerLabel: "Home" }} />
      <Drawer.Screen name="search" options={{ title: "Search", drawerLabel: "Search" }} />
      <Drawer.Screen name="files" options={{ title: "Files", drawerLabel: "Files" }} />
      <Drawer.Screen name="terminal" options={{ title: "Terminal", drawerLabel: "Terminal" }} />
      <Drawer.Screen name="integrations" options={{ title: "Integrations", drawerLabel: "Integrations" }} />
      <Drawer.Screen name="apps" options={{ title: "Apps", drawerLabel: "Apps" }} />
    </Drawer>
  );
}

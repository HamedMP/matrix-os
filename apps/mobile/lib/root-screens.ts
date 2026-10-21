// How each screen of the app's root stack comes and goes, in one place.
interface RootScreenOptions {
  headerShown: false;
  animation?: "fade";
  presentation?: "modal" | "fullScreenModal";
}

export const ROOT_SCREEN_OPTIONS = {
  // The startup gate and the shell cross-fade into each other, so the app
  // settles in at launch instead of sliding in.
  index: { headerShown: false, animation: "fade" },
  "(drawer)": { headerShown: false, animation: "fade" },
  // Pages pushed over the tabs: they slide in from the side and go back with
  // a swipe from the left edge.
  "settings-detail": { headerShown: false },
  "integration-detail": { headerShown: false },
  // Sheets raised over the app: they close with a swipe down.
  "file-browser": { headerShown: false, presentation: "modal" },
  "integrations-installed": { headerShown: false, presentation: "modal" },
  "sign-in": { headerShown: false, presentation: "modal" },
  // Full screen, closed with their own button only: a swipe there belongs to
  // the terminal or to the app inside.
  "terminal-session": { headerShown: false, presentation: "fullScreenModal" },
  "app-preview": { headerShown: false, presentation: "fullScreenModal" },
} as const satisfies Record<string, RootScreenOptions>;

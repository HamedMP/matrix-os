/**
 * The bottom tab bar is an absolute overlay (frosted, anchored to the screen
 * edge), so tab screens with their own bottom-anchored UI must pad by its
 * height. Single source of truth shared by the tabs layout and screens.
 */
export function bottomTabBarHeight(insetsBottom: number): number {
  return (process.env.EXPO_OS === "ios" ? 56 : 60) + insetsBottom;
}

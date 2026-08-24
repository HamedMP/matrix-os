import { NATIVE_DESKTOP_WINDOW_SHELL } from "./feature-flags";

export const HOSTED_SHELL_TAB_SPEC = {
  kind: "home" as const,
  title: NATIVE_DESKTOP_WINDOW_SHELL ? "Browser" : "Home",
  closable: false,
};

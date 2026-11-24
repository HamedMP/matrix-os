import "./design/index.css";
import { desktopFonts } from "@matrix-os/brand/tokens";
import { isTerminalWindowLocation } from "../../shared/terminal-window";
import { startDesktopRenderer } from "./renderer-startup";

document.documentElement.style.setProperty("--font-ui", desktopFonts.sans);
document.documentElement.style.setProperty("--font-heading", desktopFonts.display);

// One trusted bundle serves both windows. Each loads only its own root, so the
// Terminal window never runs the main app's stores, analytics or embeds.
startDesktopRenderer({
  container: document.getElementById("root")!,
  loadRoot: () => isTerminalWindowLocation(window.location.search)
    ? import("./features/terminal-window/TerminalWindowApp")
    : import("./App"),
});

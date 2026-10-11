import ReactDOM from "react-dom/client";
import { mountDesktopRenderer } from "./bootstrap";
import "./design/index.css";
import { desktopFonts } from "@matrix-os/brand/tokens";

document.documentElement.style.setProperty("--font-ui", desktopFonts.sans);
document.documentElement.style.setProperty("--font-heading", desktopFonts.display);

void mountDesktopRenderer(ReactDOM.createRoot(document.getElementById("root")!));

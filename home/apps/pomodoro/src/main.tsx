import { renderDefaultApp } from "../../_shared/default-apps";
import "../../_shared/gallery-family.css";
import "../../_shared/app-identities.css";
import "../../_shared/matrix-brand.css";

document.documentElement.dataset.app = "pomodoro";

renderDefaultApp("pomodoro" as const);

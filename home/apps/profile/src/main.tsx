import { renderDefaultApp } from "../../_shared/default-apps";
import "../../_shared/matrix-brand.css";

document.documentElement.dataset.app = "profile";

renderDefaultApp("profile" as const);

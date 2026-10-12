import { renderDefaultApp } from "../../_shared/default-apps";
import "../../_shared/matrix-brand.css";

document.documentElement.dataset.app = "social";

renderDefaultApp("social" as const);

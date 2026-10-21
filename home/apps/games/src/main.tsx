import { renderDefaultApp } from "../../_shared/default-apps";
import "./styles.css";
import "../../_shared/matrix-brand.css";

document.documentElement.dataset.app = "games";

renderDefaultApp("games" as const);

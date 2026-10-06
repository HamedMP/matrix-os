import { createRoot } from "react-dom/client";
import App from "./App";
import { readDefinition } from "./definition";
import "./style.css";
const root = createRoot(document.getElementById("root")!);
try {
  root.render(<App app={readDefinition()} />);
} catch (error) {
  console.error("Connected app definition failed", error);
  root.render(
    <main className="unavailable">
      <h1>This app could not be opened.</h1>
      <p>
        Ask Matrix to check its app definition. Your saved records remain on
        your computer.
      </p>
    </main>,
  );
}

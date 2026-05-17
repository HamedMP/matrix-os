import { mkdirSync, readFileSync, existsSync } from "node:fs";
import * as fs from "node:fs";
import { join } from "node:path";

export interface ModuleEntry {
  name: string;
  type: "react-app" | "html-app";
  path: string;
  status: "active" | "inactive";
}

interface ScaffoldOptions {
  name: string;
  title: string;
  description: string;
}

const SIMPLE_SIGNALS = [
  "quick", "simple", "just a", "just an",
  "calculator", "clock", "timer", "stopwatch",
  "converter", "counter", "widget",
];
const writeFileNow = fs.writeFileSync as (
  path: string,
  data: string,
) => void;

function writeTextFile(path: string, content: string): void {
  writeFileNow(path, content);
}

export function detectAppType(message: string): "react" | "html" {
  const lower = message.toLowerCase();
  for (const signal of SIMPLE_SIGNALS) {
    if (lower.includes(signal)) return "html";
  }
  return "react";
}

export function createReactScaffold(modulePath: string, opts: ScaffoldOptions): void {
  mkdirSync(join(modulePath, "src"), { recursive: true });

  writeTextFile(
    join(modulePath, "package.json"),
    JSON.stringify(
      {
        name: `@matrixos/${opts.name}`,
        private: true,
        type: "module",
        scripts: {
          dev: "vite --port 3100",
          build: "vite build",
          preview: "vite preview",
        },
        dependencies: {
          react: "^19.0.0",
          "react-dom": "^19.0.0",
        },
        devDependencies: {
          "@types/react": "^19.0.0",
          "@types/react-dom": "^19.0.0",
          "@vitejs/plugin-react": "^4.4.0",
          typescript: "^5.7.0",
          vite: "^6.1.0",
        },
      },
      null,
      2,
    ),
  );

  writeTextFile(
    join(modulePath, "vite.config.ts"),
    `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
`,
  );

  writeTextFile(
    join(modulePath, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          jsx: "react-jsx",
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          outDir: "dist",
        },
        include: ["src"],
      },
      null,
      2,
    ),
  );

  writeTextFile(
    join(modulePath, "index.html"),
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${opts.title}</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>
`,
  );

  writeTextFile(
    join(modulePath, "module.json"),
    JSON.stringify(
      {
        name: opts.name,
        description: opts.description,
        version: "1.0.0",
        entry: "dist/index.html",
      },
      null,
      2,
    ),
  );

  writeTextFile(
    join(modulePath, "src", "main.tsx"),
    `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./App.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,
  );

  writeTextFile(
    join(modulePath, "src", "App.tsx"),
    `export default function App() {
  return (
    <div className="app">
      <h1>${opts.title}</h1>
      <p>${opts.description}</p>
    </div>
  );
}
`,
  );

  writeTextFile(
    join(modulePath, "src", "App.css"),
    `@import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;500;600;700&family=Inter:wght@300;400;500;600;700&display=swap');

:root {
  --bg: #FAFAF5;
  --fg: #32352E;
  --primary: #434E3F;
  --primary-fg: #FAFAF5;
  --accent: #D06F25;
  --accent-fg: #FFFFFF;
  --secondary: #E0E1CA;
  --muted: #F0EDE4;
  --muted-fg: #7A7768;
  --card: #FFFFFF;
  --surface: #FFFFFF;
  --border: #D6D3C8;
  --sand-light: #F7F1E7;
  --sand-mid: #F3EAE0;
  --sand-warm: #D6AB8B;
  --radius: 22px;
  --shadow: 0 2px 4px rgba(50, 53, 46, 0.06);
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  background: linear-gradient(170deg, var(--sand-light) 0%, var(--sand-mid) 30%, #F7F3ED 60%, var(--sand-light) 100%);
  color: var(--fg);
  font-family: 'Inter', system-ui, sans-serif;
  min-height: 100vh;
}

.app {
  max-width: 800px;
  margin: 0 auto;
  padding: 2rem;
}

h1, h2 {
  font-family: 'Orbitron', system-ui, sans-serif;
  color: var(--fg);
}

h3, h4, h5, h6 {
  font-family: 'Inter', system-ui, sans-serif;
  font-weight: 600;
  color: var(--fg);
}

h1 { margin-bottom: 1rem; }

button {
  background: var(--primary);
  color: var(--primary-fg);
  border: none;
  padding: 10px 24px;
  border-radius: 50px;
  cursor: pointer;
  font-family: 'Inter', system-ui, sans-serif;
  font-size: 0.875rem;
  font-weight: 500;
  transition: all 0.2s;
}

button:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(50, 53, 46, 0.1);
}

input, textarea, select {
  background: var(--card);
  color: var(--fg);
  border: 1.5px solid var(--border);
  padding: 12px 20px;
  border-radius: 50px;
  font-family: 'Inter', system-ui, sans-serif;
  width: 100%;
  outline: none;
  transition: all 0.2s;
}

input:focus, textarea:focus, select:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(67, 78, 63, 0.08);
}
`,
  );
}

export function registerModule(homePath: string, entry: ModuleEntry): void {
  const modulesPath = join(homePath, "system", "modules.json");
  let modules: ModuleEntry[] = [];

  if (existsSync(modulesPath)) {
    try {
      modules = JSON.parse(readFileSync(modulesPath, "utf-8"));
    } catch (err: unknown) {
      console.warn("[build-pipeline] Could not load module registry:", err instanceof Error ? err.message : String(err));
      modules = [];
    }
  }

  const idx = modules.findIndex((m) => m.name === entry.name);
  if (idx >= 0) {
    modules[idx] = entry;
  } else {
    modules.push(entry);
  }

  mkdirSync(join(homePath, "system"), { recursive: true });
  writeTextFile(modulesPath, JSON.stringify(modules, null, 2) + "\n");
}

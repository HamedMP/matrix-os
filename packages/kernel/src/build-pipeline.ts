import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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

export function detectAppType(message: string): "react" | "html" {
  const lower = message.toLowerCase();
  for (const signal of SIMPLE_SIGNALS) {
    if (lower.includes(signal)) return "html";
  }
  return "react";
}

export function createReactScaffold(modulePath: string, opts: ScaffoldOptions): void {
  mkdirSync(join(modulePath, "src"), { recursive: true });

  writeFileSync(
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

  writeFileSync(
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

  writeFileSync(
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

  writeFileSync(
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

  writeFileSync(
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

  writeFileSync(
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

  writeFileSync(
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

  writeFileSync(
    join(modulePath, "src", "App.css"),
    `:root {
  --bg: #0a0a0a;
  --fg: #ededed;
  --accent: #6c5ce7;
  --surface: #1a1a2e;
  --border: #2a2a3a;
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  min-height: 100vh;
}

.app {
  max-width: 800px;
  margin: 0 auto;
  padding: 2rem;
}

h1 {
  margin-bottom: 1rem;
}

button {
  background: var(--accent);
  color: white;
  border: none;
  padding: 8px 16px;
  border-radius: 6px;
  cursor: pointer;
}

button:hover {
  opacity: 0.9;
}

input, textarea {
  background: var(--surface);
  color: var(--fg);
  border: 1px solid var(--border);
  padding: 8px;
  border-radius: 6px;
  width: 100%;
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
    } catch {
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
  writeFileSync(modulesPath, JSON.stringify(modules, null, 2) + "\n");
}

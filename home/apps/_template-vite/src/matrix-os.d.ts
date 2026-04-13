interface MatrixOS {
  query(prompt: string): Promise<string>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listFiles(dir: string): Promise<string[]>;
  getTheme(): { mode: "light" | "dark"; accent: string };
}

declare global {
  interface Window {
    MatrixOS: MatrixOS;
  }
}

export {};

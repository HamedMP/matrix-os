interface MatrixOS {
  readData?(key: string): Promise<unknown>;
  writeData?(key: string, value: unknown): Promise<void>;
  onDataChange?(callback: (key: string, app: string) => void): () => void;
}

declare global {
  interface Window {
    MatrixOS?: MatrixOS;
  }
}

export {};

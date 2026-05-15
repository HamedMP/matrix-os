export {};

declare global {
  interface Window {
    MatrixOS?: {
      openApp?: (name: string, path: string) => void;
    };
  }
}
